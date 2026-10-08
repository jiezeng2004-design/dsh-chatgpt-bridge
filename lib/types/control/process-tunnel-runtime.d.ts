/**
 * ProcessTunnelRuntime: plugin-owned `tunnel-client run` supervision.
 *
 * v0.4.0's default backend. Starts tunnel-client as a child of the plugin
 * (spawn, shell:false, structured argv), discovers its loopback health URL,
 * tracks a full ProcessIdentity (pid + startedAt + executable + per-launch
 * runtimeInstanceId), and stops ONLY the verified owned process. Never kills
 * by port and never kills every tunnel-client.
 */
import { spawn, spawnSync } from 'node:child_process';
import { type IdentityVerification } from './process-identity.js';
import { type DiscoveredExecutable } from './discover.js';
import type { ProcessIdentity, TunnelDetectionResult, TunnelDoctorResult, TunnelLaunchConfig, TunnelRuntimeHandle, TunnelRuntimeStatus } from './types.js';
import type { TunnelRuntime } from './tunnel-runtime.js';
export interface ControlLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/** Last non-empty line of a child-process chunk, redacted and length-capped for error messages. */
export declare function lastChildLine(chunk: Buffer): string | undefined;
/**
 * Explain a missing health URL with the child's own last words when we have them.
 *
 * A tunnel-client that rejects the plugin's argv (for example the reduced
 * `tunnel-client-runtime` build, which does not accept `--admin-ui.log-buffer-events`)
 * exits immediately. Reporting only "did not report a health URL in time" hides
 * that, and reads like a network or credential problem.
 */
export declare function startupFailureDetail(exitStatus: {
    code: number | null;
    signal: NodeJS.Signals | null;
} | undefined, lastStderrLine: string | undefined): string;
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
export declare class ProcessTunnelRuntime implements TunnelRuntime {
    private configuredExecutable;
    private child;
    private handle;
    private healthBaseUrl;
    private config;
    private readonly logger;
    private readonly spawnFn;
    private readonly spawnSyncFn;
    private readonly httpGetStatusFn;
    private readonly isAliveFn;
    private readonly now;
    private readonly discover;
    private readonly verifyIdentityFn;
    private readonly platform;
    private readonly processKillFn;
    private readonly gracefulTimeoutMs;
    private readonly hardKillTimeoutMs;
    private readonly healthUrlTimeoutMs;
    constructor(options?: ProcessTunnelRuntimeOptions);
    /** Update runtime-wide settings (executable path) before detect/start. */
    configure(options: {
        executable?: string;
    }): void;
    get currentHandle(): TunnelRuntimeHandle | undefined;
    detect(): Promise<TunnelDetectionResult>;
    private readVersion;
    start(config: TunnelLaunchConfig): Promise<TunnelRuntimeHandle>;
    private logLine;
    private waitForHealthUrl;
    stop(handle: TunnelRuntimeHandle): Promise<void>;
    ownedHandle(): TunnelRuntimeHandle | undefined;
    /**
     * Verify the live process still matches the recorded identity. Probe
     * exceptions fail closed (cannot confirm ownership).
     */
    private verifyOwned;
    /** Alive-or-unknown: a throwing probe is treated as still alive (fail closed). */
    private processStillAlive;
    private refuseStale;
    /**
     * Ownership-safe termination. Every destructive signal — SIGTERM,
     * SIGKILL, and Windows `taskkill /T /F` — is gated on a fresh identity
     * verification (pid + executable + start time). There is no production
     * path that skips this check.
     */
    private stopOwned;
    private signalGraceful;
    private signalHardKill;
    private waitForExit;
    private cleanupOwned;
    status(handle?: TunnelRuntimeHandle): Promise<TunnelRuntimeStatus>;
    private probeHealth;
    doctor(config: TunnelLaunchConfig): Promise<TunnelDoctorResult>;
    dispose(): Promise<void>;
}
