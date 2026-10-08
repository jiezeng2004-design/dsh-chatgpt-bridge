/**
 * ProcessTunnelRuntime: plugin-owned `tunnel-client run` supervision.
 *
 * v0.4.0's default backend. Starts tunnel-client as a child of the plugin
 * (spawn, shell:false, structured argv), discovers its loopback health URL,
 * tracks a full ProcessIdentity (pid + startedAt + executable + per-launch
 * runtimeInstanceId), and stops ONLY the verified owned process. Never kills
 * by port and never kills every tunnel-client.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

import { normalizeSocketHostname } from '../config.js';
import { redactText } from '../redact.js';
import {
  createProcessIdentity,
  isProcessAlive,
  verifyProcessIdentity,
  type IdentityVerification,
} from './process-identity.js';
import { discoverExecutable, type DiscoveredExecutable } from './discover.js';
import { RuntimeError } from './tunnel-runtime.js';
import type {
  ProcessIdentity,
  TunnelDetectionResult,
  TunnelDoctorResult,
  TunnelLaunchConfig,
  TunnelRuntimeHandle,
  TunnelRuntimeStatus,
} from './types.js';
import type { TunnelRuntime } from './tunnel-runtime.js';

export interface ControlLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Last non-empty line of a child-process chunk, redacted and length-capped for error messages. */
export function lastChildLine(chunk: Buffer): string | undefined {
  const lines = chunk
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1);
  return last === undefined ? undefined : redactText(last).slice(0, 300);
}

/**
 * Explain a missing health URL with the child's own last words when we have them.
 *
 * A tunnel-client that rejects the plugin's argv (for example the reduced
 * `tunnel-client-runtime` build, which does not accept `--admin-ui.log-buffer-events`)
 * exits immediately. Reporting only "did not report a health URL in time" hides
 * that, and reads like a network or credential problem.
 */
export function startupFailureDetail(
  exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined,
  lastStderrLine: string | undefined,
): string {
  const parts = ['tunnel-client did not report a health URL in time'];
  if (exitStatus !== undefined) parts.push(`exit=${exitStatus.code} signal=${String(exitStatus.signal)}`);
  if (lastStderrLine !== undefined) parts.push(`last stderr: ${lastStderrLine}`);
  return parts.join('; ');
}

export interface ProcessTunnelRuntimeOptions {
  logger?: ControlLogger;
  /** Injectable spawn for tests. */
  spawnFn?: typeof spawn;
  spawnSyncFn?: typeof spawnSync;
  /** Injectable health probe for tests: GET baseUrl + path, returns status or undefined. */
  httpGetStatusFn?: (url: string, timeoutMs: number) => Promise<number | undefined>;
  /** Injectable process-alive check for tests. */
  isAliveFn?: (pid: number) => boolean;
  now?: () => number;
  /** Injectable binary discovery (tests isolate well-known / PATH / process scan). */
  discoverExecutable?: (configured?: string) => DiscoveredExecutable | undefined;
  /**
   * Injectable identity verification. Production always uses the real
   * ProcessIdentity probes (pid + executable + start time). Tests inject this
   * to simulate PID reuse / probe failure without a live OS process.
   */
  verifyIdentityFn?: (identity: ProcessIdentity) => IdentityVerification;
  /** Injectable platform so Windows taskkill vs POSIX SIGKILL is testable off-host. */
  platform?: NodeJS.Platform;
  /** Injectable process.kill (SIGTERM / SIGKILL). Tests assert hard-kill is skipped. */
  processKillFn?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  /** Graceful-stop wait before hard-kill escalation (ms). */
  gracefulTimeoutMs?: number;
  /** Wait after SIGKILL / taskkill /F (ms). */
  hardKillTimeoutMs?: number;
  /** How long start() waits for the health URL file (ms). */
  healthUrlTimeoutMs?: number;
}

interface ProcessHandle extends TunnelRuntimeHandle {
  readonly kind: 'process';
}

function defaultLogger(): ControlLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function resolveDiscovered(
  discover: (configured?: string) => DiscoveredExecutable | undefined,
  configured: string | undefined,
): DiscoveredExecutable | undefined {
  return discover(configured);
}

function parseVersion(output: string): string | undefined {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match === null ? undefined : match[1];
}

export class ProcessTunnelRuntime implements TunnelRuntime {
  private configuredExecutable: string | undefined;
  private child: ChildProcess | undefined;
  private handle: ProcessHandle | undefined;
  private healthBaseUrl: string | undefined;
  private config: TunnelLaunchConfig | undefined;
  private readonly logger: ControlLogger;
  private readonly spawnFn: typeof spawn;
  private readonly spawnSyncFn: typeof spawnSync;
  private readonly httpGetStatusFn: (url: string, timeoutMs: number) => Promise<number | undefined>;
  private readonly isAliveFn: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly discover: (configured?: string) => DiscoveredExecutable | undefined;
  private readonly verifyIdentityFn: (identity: ProcessIdentity) => IdentityVerification;
  private readonly platform: NodeJS.Platform;
  private readonly processKillFn: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  private readonly gracefulTimeoutMs: number;
  private readonly hardKillTimeoutMs: number;
  private readonly healthUrlTimeoutMs: number;

  constructor(options: ProcessTunnelRuntimeOptions = {}) {
    this.logger = options.logger ?? defaultLogger();
    this.spawnFn = options.spawnFn ?? spawn;
    this.spawnSyncFn = options.spawnSyncFn ?? spawnSync;
    this.httpGetStatusFn = options.httpGetStatusFn ?? httpGetStatus;
    this.isAliveFn = options.isAliveFn ?? isProcessAlive;
    this.now = options.now ?? (() => Date.now());
    this.discover =
      options.discoverExecutable ??
      ((configured) => discoverExecutable({ configuredExecutable: configured }));
    this.verifyIdentityFn = options.verifyIdentityFn ?? ((identity) => verifyProcessIdentity(identity));
    this.platform = options.platform ?? process.platform;
    this.processKillFn = options.processKillFn ?? ((pid, signal) => process.kill(pid, signal));
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
    this.hardKillTimeoutMs = options.hardKillTimeoutMs ?? 5_000;
    this.healthUrlTimeoutMs = options.healthUrlTimeoutMs ?? 15_000;
  }

  /** Update runtime-wide settings (executable path) before detect/start. */
  configure(options: { executable?: string }): void {
    if (options.executable !== undefined) this.configuredExecutable = options.executable;
  }

  get currentHandle(): TunnelRuntimeHandle | undefined {
    return this.handle;
  }

  async detect(): Promise<TunnelDetectionResult> {
    const found = resolveDiscovered(this.discover, this.configuredExecutable);
    if (found === undefined) {
      return { installed: false, error: 'tunnel-client-not-found' };
    }
    const version = await this.readVersion(found.path);
    return {
      installed: true,
      executablePath: found.path,
      source: found.source,
      ...(version === undefined ? {} : { version }),
    };
  }

  private readVersion(executable: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      try {
        const result = this.spawnSyncFn(executable, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        resolve(parseVersion((result.stdout ?? '') + (result.stderr ?? '')));
      } catch {
        resolve(undefined);
      }
    });
  }

  async start(config: TunnelLaunchConfig): Promise<TunnelRuntimeHandle> {
    if (this.child !== undefined && this.child.exitCode === null) {
      if (this.handle !== undefined) return this.handle;
    }
    const executable = resolveDiscovered(this.discover, config.executablePath)?.path;
    if (executable === undefined) {
      throw new RuntimeError('tunnel-client-not-installed', 'tunnel-client executable not found', 'tunnel');
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, config.env ?? {});
    const args: string[] = [
      'run',
      '--profile-file', config.profilePath,
      // Flags outrank inherited CONTROL_PLANE_API_KEY / OPENAI_API_KEY and
      // YAML in tunnel-client. Pin plugin-owned runs to the same SecretStore
      // file that RuntimeManager probes, so parent-process credentials cannot
      // silently replace the configured plugin key.
      '--control-plane.api-key', config.runtimeApiKeyRef,
      '--health.listen-addr', '127.0.0.1:0',
      '--log.level', 'info',
      '--log.format', 'json',
      '--admin-ui.log-buffer-events', '200',
    ];
    if (config.healthUrlFile !== undefined && config.healthUrlFile !== '') args.push('--health.url-file', config.healthUrlFile);
    if (config.pidFile !== undefined && config.pidFile !== '') args.push('--pid.file', config.pidFile);
    if (config.logFile !== undefined && config.logFile !== '') args.push('--log.file', config.logFile);
    if (config.proxy?.enabled === true) {
      const proxyUrl = `${config.proxy.scheme}://${config.proxy.host}:${config.proxy.port}`;
      args.push('--http-proxy', proxyUrl);
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.ALL_PROXY = proxyUrl;
      env.NO_PROXY = '127.0.0.1,localhost,::1';
    }
    this.logger.info(`spawning tunnel-client run (shell:false) pid will be recorded from child`);
    let child: ChildProcess;
    try {
      child = this.spawnFn(executable, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      throw new RuntimeError('tunnel-spawn-failed', error instanceof Error ? error.message : String(error), 'tunnel');
    }
    this.child = child;
    const handle: ProcessHandle = {
      kind: 'process',
      identity: createProcessIdentity({
        pid: child.pid ?? 0,
        executablePath: executable,
        profileName: config.profileName,
        tunnelId: config.tunnelId,
      }),
    };
    this.handle = handle;
    this.config = config;
    if (child.pid === undefined || child.pid <= 0) {
      this.child = undefined;
      this.handle = undefined;
      throw new RuntimeError('tunnel-spawn-failed', 'child process pid unavailable', 'tunnel');
    }
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let lastStderrLine: string | undefined;
    child.once('exit', (code, signal) => {
      exitStatus = { code, signal };
      this.logger.warn(`tunnel-client exited code=${code} signal=${String(signal)}`);
    });
    child.stdout?.on('data', (chunk: Buffer) => this.logLine('info', chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.logLine('warn', chunk);
      lastStderrLine = lastChildLine(chunk) ?? lastStderrLine;
    });
    // Wait for the health URL file (loopback discovery). A timeout still
    // stops through the ownership-verified path — never skip identity checks
    // just because this is a process we just spawned.
    const healthBase = await this.waitForHealthUrl(config.healthUrlFile, this.healthUrlTimeoutMs);
    if (healthBase === undefined) {
      // Capture the child's own failure story before cleanup: stopping the owned
      // process overwrites the exit status observers we rely on here.
      const detail = startupFailureDetail(exitStatus, lastStderrLine);
      await this.stopOwned(handle);
      throw new RuntimeError('tunnel-health-url-timeout', detail, 'tunnel');
    }
    this.healthBaseUrl = healthBase;
    this.logger.info(`tunnel health base: ${healthBase}`);
    return handle;
  }

  private logLine(level: 'info' | 'warn', chunk: Buffer): void {
    const text = chunk.toString('utf8').trim();
    if (text === '') return;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      if (level === 'info') this.logger.info(line);
      else this.logger.warn(line);
    }
  }

  private async waitForHealthUrl(urlFile: string | undefined, timeoutMs: number): Promise<string | undefined> {
    if (urlFile === undefined || urlFile === '') return undefined;
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      try {
        if (existsSync(urlFile)) {
          const raw = readFileSync(urlFile, 'utf8').trim();
          if (raw !== '') return raw;
        }
      } catch {
        // keep waiting
      }
      await sleep(250);
    }
    return undefined;
  }

  async stop(handle: TunnelRuntimeHandle): Promise<void> {
    await this.stopOwned(handle);
  }

  ownedHandle(): TunnelRuntimeHandle | undefined {
    return this.handle;
  }

  /**
   * Verify the live process still matches the recorded identity. Probe
   * exceptions fail closed (cannot confirm ownership).
   */
  private verifyOwned(identity: ProcessIdentity): IdentityVerification {
    try {
      return this.verifyIdentityFn(identity);
    } catch {
      return { ok: false, code: 'unknown-executable' };
    }
  }

  /** Alive-or-unknown: a throwing probe is treated as still alive (fail closed). */
  private processStillAlive(pid: number): boolean {
    try {
      return this.isAliveFn(pid);
    } catch {
      return true;
    }
  }

  private refuseStale(verification: IdentityVerification, action: 'stop' | 'hard-kill'): never {
    throw new RuntimeError(
      'stale-process-identity',
      `refusing ${action}: process identity no longer matches (${verification.code})`,
      'tunnel',
    );
  }

  /**
   * Ownership-safe termination. Every destructive signal — SIGTERM,
   * SIGKILL, and Windows `taskkill /T /F` — is gated on a fresh identity
   * verification (pid + executable + start time). There is no production
   * path that skips this check.
   */
  private async stopOwned(handle: TunnelRuntimeHandle): Promise<void> {
    const first = this.verifyOwned(handle.identity);
    if (first.code === 'not-alive') {
      this.cleanupOwned(handle);
      return;
    }
    if (!first.ok) this.refuseStale(first, 'stop');

    this.signalGraceful(handle);

    if (await this.waitForExit(handle.identity.pid, this.gracefulTimeoutMs)) {
      this.cleanupOwned(handle);
      return;
    }

    // Hard-kill gate: the PID may have been reused during the graceful wait.
    // Re-verify immediately before SIGKILL / taskkill /F. Any mismatch,
    // unreadable probe, thrown probe, or missing process fails closed.
    const second = this.verifyOwned(handle.identity);
    if (second.code === 'not-alive') {
      this.cleanupOwned(handle);
      return;
    }
    if (!second.ok) this.refuseStale(second, 'hard-kill');

    this.signalHardKill(handle.identity.pid);

    if (!(await this.waitForExit(handle.identity.pid, this.hardKillTimeoutMs))) {
      throw new RuntimeError('tunnel-stop-timeout', 'tunnel-client did not exit after stop', 'tunnel');
    }
    this.cleanupOwned(handle);
  }

  private signalGraceful(handle: TunnelRuntimeHandle): void {
    const pid = handle.identity.pid;
    if (this.child !== undefined && this.child.pid === pid && this.child.exitCode === null) {
      try {
        this.child.kill();
        return;
      } catch {
        // fall through to SIGTERM
      }
    }
    try {
      this.processKillFn(pid, 'SIGTERM');
    } catch {
      // process already gone
    }
  }

  private signalHardKill(pid: number): void {
    if (this.platform === 'win32') {
      this.spawnSyncFn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
      return;
    }
    try {
      this.processKillFn(pid, 'SIGKILL');
    } catch {
      // ignore: waitForExit decides whether the process is gone
    }
  }

  private waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    return waitUntil(() => !this.processStillAlive(pid), timeoutMs, this.now);
  }

  private cleanupOwned(handle: TunnelRuntimeHandle): void {
    if (this.handle === handle) {
      const config = this.config;
      this.child = undefined;
      this.handle = undefined;
      this.healthBaseUrl = undefined;
      this.config = undefined;
      try {
        if (config?.healthUrlFile !== undefined) rmSync(config.healthUrlFile, { force: true });
      } catch {
        // best-effort
      }
      try {
        if (config?.pidFile !== undefined) rmSync(config.pidFile, { force: true });
      } catch {
        // best-effort
      }
    }
  }

  async status(handle?: TunnelRuntimeHandle): Promise<TunnelRuntimeStatus> {
    const active = handle ?? this.handle;
    if (active === undefined) {
      return { status: 'stopped', processRunning: false, healthy: false, ready: false };
    }
    if (this.child !== undefined && this.child.exitCode !== null) {
      return {
        status: 'error',
        processRunning: false,
        healthy: false,
        ready: false,
        lastError: { code: 'unexpected-exit', message: `tunnel-client exited with code ${this.child.exitCode}` },
      };
    }
    if (!this.isAliveFn(active.identity.pid)) {
      return {
        status: 'error',
        processRunning: false,
        healthy: false,
        ready: false,
        lastError: { code: 'unexpected-exit', message: 'tunnel-client process is no longer alive' },
      };
    }
    if (this.healthBaseUrl === undefined) {
      return { status: 'starting', processRunning: true, healthy: false, ready: false, pid: active.identity.pid };
    }
    const [healthy, ready] = await Promise.all([
      this.probeHealth(this.healthBaseUrl, '/healthz'),
      this.probeHealth(this.healthBaseUrl, '/readyz'),
    ]);
    if (!healthy) {
      return { status: 'running', processRunning: true, healthy: false, ready: false, pid: active.identity.pid, lastError: { code: 'health-failed', message: 'tunnel /healthz not live' } };
    }
    if (!ready) {
      return { status: 'running', processRunning: true, healthy: true, ready: false, pid: active.identity.pid, lastError: { code: 'ready-failed', message: 'tunnel /readyz not ready' } };
    }
    return { status: 'running', processRunning: true, healthy: true, ready: true, pid: active.identity.pid, healthUrl: this.healthBaseUrl };
  }

  private async probeHealth(baseUrl: string, path: string): Promise<boolean> {
    try {
      const status = await this.httpGetStatusFn(baseUrl + path, 2000);
      return status !== undefined && status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  async doctor(config: TunnelLaunchConfig): Promise<TunnelDoctorResult> {
    const executable = resolveDiscovered(this.discover, config.executablePath)?.path;
    if (executable === undefined) {
      return { ok: false, steps: [{ id: 'binary', ok: false, code: 'tunnel-client-not-installed', detail: 'tunnel-client executable not found' }] };
    }
    try {
      const result = this.spawnSyncFn(
        executable,
        ['doctor', '--profile-file', config.profilePath, '--control-plane.api-key', config.runtimeApiKeyRef, '--json'],
        {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        },
      );
      const raw = (result.stdout ?? '').trim() || (result.stderr ?? '').trim();
      let parsed: { result?: string; checks?: { id: string; status: string; summary?: string }[] } | undefined;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      const checks = parsed?.checks ?? [];
      const steps = checks.map((check) => ({
        id: check.id,
        ok: check.status === 'PASS',
        ...(check.summary === undefined ? {} : { detail: check.summary }),
      }));
      return { ok: steps.every((step) => step.ok), steps };
    } catch (error) {
      return {
        ok: false,
        steps: [{ id: 'doctor', ok: false, code: 'doctor-failed', detail: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.handle !== undefined) {
      try {
        await this.stopOwned(this.handle);
      } catch {
        // best-effort during unload
      }
    }
    this.child = undefined;
    this.handle = undefined;
  }
}

function httpGetStatus(url: string, timeoutMs: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const getFn = u.protocol === 'https:' ? httpsGet : httpGet;
    const req = getFn(
      { host: normalizeSocketHostname(u.hostname), port: u.port === '' ? undefined : Number(u.port), path: u.pathname, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolve(undefined));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, timeoutMs: number, now: () => number): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (condition()) return true;
    await sleep(100);
  }
  return condition();
}
