import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import z from '@deepseek-ai/schemastery';
import type { LogLevel } from './log.js';

/**
 * Plugin configuration (schemastery schema, DSH convention). All defaults are
 * security-first: loopback-only host, bearer-token auth, bounded result sizes.
 */
export const ConfigSchema = z.object({
  /** Tool mode: 'controller' exposes DSH controls; 'advisor' exposes planning/review tools only. */
  mode: z.union([z.const('controller'), z.const('advisor')]).default('controller'),
  /** MCP transport: 'http' (Streamable HTTP) or 'stdio' (local MCP clients). */
  transport: z.union([z.const('http'), z.const('stdio')]).default('http'),
  /** Bind host for the Streamable HTTP server. Loopback only by default. */
  host: z.string().default('127.0.0.1'),
  /** Bind port for the Streamable HTTP server. */
  port: z.number().min(1).max(65535).default(3456),
  /** 'token' requires Authorization: Bearer <token>; 'none' disables auth (loopback only, not recommended). */
  authMode: z.union([z.const('token'), z.const('none')]).default('token'),
  /** Static token; empty falls back to authTokenEnv, then a generated token persisted to tokenFile. */
  authToken: z.string().default(''),
  /** Environment variable read when authToken is empty. */
  authTokenEnv: z.string().default('DSH_CHATGPT_BRIDGE_TOKEN'),
  /** Where a generated token is persisted; empty means $DSH_HOME/chatgpt-bridge.token. */
  tokenFile: z.string().default(''),
  /** Max characters of assistant text returned by dsh_get_result. */
  resultMaxChars: z.number().default(8000),
  /** Max tool calls returned by dsh_get_result. */
  resultMaxItems: z.number().default(50),
  /** Max message rows returned by dsh_get_session. */
  sessionMaxItems: z.number().default(20),
  /** Max characters per message text returned by dsh_get_session. */
  sessionMaxChars: z.number().default(4000),
  /** Log verbosity: debug | info | warn | error. */
  logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info'),
  /** Risk-tiered auto-approval policy. Omitted fields keep the safe defaults. */
  approvalPolicy: z.object({
    read: z.union([z.const('auto'), z.const('ask')]).default('auto'),
    test: z.union([z.const('auto'), z.const('ask')]).default('auto'),
    build: z.union([z.const('auto'), z.const('ask')]).default('auto'),
    workspaceWrite: z.union([z.const('auto'), z.const('ask')]).default('auto'),
    localCommit: z.union([z.const('auto'), z.const('ask')]).default('auto'),
    externalWrite: z.union([z.const('auto'), z.const('ask')]).default('ask'),
    gitPush: z.union([z.const('auto'), z.const('ask')]).default('ask'),
    npmPublish: z.union([z.const('auto'), z.const('ask')]).default('ask'),
    githubRelease: z.union([z.const('auto'), z.const('ask')]).default('ask'),
    secrets: z.union([z.const('deny'), z.const('ask')]).default('deny'),
    dangerFullAccess: z.union([z.const('deny'), z.const('ask')]).default('ask'),
  }).default({
    read: 'auto',
    test: 'auto',
    build: 'auto',
    workspaceWrite: 'auto',
    localCommit: 'auto',
    externalWrite: 'ask',
    gitPush: 'ask',
    npmPublish: 'ask',
    githubRelease: 'ask',
    secrets: 'deny',
    dangerFullAccess: 'ask',
  }),
});

import type { UserApprovalPolicy } from './approval-policy.js';

/** Input shape accepted from the cordis row config (schema input side). */
export interface BridgeConfigInput {
  mode?: 'controller' | 'advisor';
  transport?: 'http' | 'stdio';
  host?: string;
  port?: number;
  authMode?: 'token' | 'none';
  authToken?: string;
  authTokenEnv?: string;
  tokenFile?: string;
  resultMaxChars?: number;
  resultMaxItems?: number;
  sessionMaxItems?: number;
  sessionMaxChars?: number;
  logLevel?: LogLevel;
  approvalPolicy?: UserApprovalPolicy;
}

/** Fully resolved configuration after token resolution. */
export interface ResolvedBridgeConfig {
  mode: 'controller' | 'advisor';
  transport: 'http' | 'stdio';
  host: string;
  port: number;
  authMode: 'token' | 'none';
  authToken: string;
  tokenFile: string;
  resultMaxChars: number;
  resultMaxItems: number;
  sessionMaxItems: number;
  sessionMaxChars: number;
  logLevel: LogLevel;
  dshHome: string;
  approvalPolicy?: UserApprovalPolicy;
}

/** Convert URL authority host syntax to the bare form required by sockets. */
export function normalizeSocketHostname(host: string): string {
  const value = host.trim();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function normalizedHost(host: string): string {
  return normalizeSocketHostname(host).toLowerCase();
}

function normalizedIpv6(host: string): string {
  return normalizeSocketHostname(new URL(`http://[${host}]/`).hostname);
}

/** True only for listener hosts whose bind scope is loopback-only. */
export function isLoopbackHost(host: string): boolean {
  const value = normalizedHost(host);
  if (value === 'localhost') return true;
  const family = isIP(value);
  if (family === 4) return value.split('.')[0] === '127';
  if (family !== 6) return false;
  const canonical = normalizedIpv6(value);
  return canonical === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(canonical);
}

/** Select a concrete address that can reach a wildcard listener locally. */
export function bridgeConnectHost(listenerHost: string): string {
  const value = normalizedHost(listenerHost);
  if (value === '0.0.0.0') return '127.0.0.1';
  if (isIP(value) === 6 && normalizedIpv6(value) === '::') return '::1';
  return value;
}

/** Build a syntactically valid local probe URL, including IPv6 brackets. */
export function bridgeHttpUrl(listenerHost: string, port: number): string {
  const host = bridgeConnectHost(listenerHost);
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${authority}:${port}/mcp`;
}

/** Read the persisted token file, if any; malformed state fails closed. */
function readTokenFile(path: string): string | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw === '' || /[\r\n]/.test(raw)) {
      throw new Error('Bridge auth token file is empty or malformed; expected one non-empty line');
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof Error && error.message.startsWith('Bridge auth token file')) throw error;
    throw new Error('Bridge auth token file could not be read', { cause: error });
  }
}

/**
 * An exclusive creator becomes visible before its tiny write is necessarily
 * observable by another process. Require the same valid value twice for both
 * initial readers and EEXIST losers. Persistent malformed content reaches the
 * bounded deadline and still fails closed; only ENOENT may proceed to create.
 */
const TOKEN_STABILIZATION_ATTEMPTS = 50;
const TOKEN_STABILIZATION_DELAY_MS = 10;

function readStableTokenFile(path: string, allowMissing: boolean): string | undefined {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let previous: string | undefined;
  for (let attempt = 0; attempt < TOKEN_STABILIZATION_ATTEMPTS; attempt += 1) {
    let current: string | undefined;
    try {
      current = readTokenFile(path);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Bridge auth token file is empty or malformed')) {
        throw error;
      }
    }
    if (current === undefined && allowMissing) return undefined;
    if (current !== undefined && current === previous) return current;
    previous = current;
    Atomics.wait(sleeper, 0, 0, TOKEN_STABILIZATION_DELAY_MS);
  }
  throw new Error('Bridge auth token file is empty or malformed after bounded stabilization');
}

/**
 * Generate a fresh token and persist it (0600 on POSIX; Windows ignores mode).
 *
 * Exclusive create: when two resolvers see the file absent in the same
 * lifecycle, only one wins the write and the loser ADOPTS the persisted
 * token. Overwriting instead (plain 'w') would leave the file with the last
 * writer's token while the first writer's process keeps its own in-memory
 * one — server and probe then diverge and every probe 401s as
 * `bridge-auth-failed`. The file is the single token authority once it
 * exists: every later resolveConfig() reads it back unchanged.
 */
function createTokenFile(path: string): string {
  const token = randomBytes(24).toString('base64url');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, token + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    // A concurrent resolver won the create: adopt the persisted token so
    // every resolver in the lifecycle converges on the same value.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && existsSync(path)) {
      const persisted = readStableTokenFile(path, false);
      if (persisted !== undefined) return persisted;
    }
    // An ephemeral fallback would let independent runtimes keep different
    // tokens. Fail closed without including token material in the error.
    throw new Error('Bridge auth token file could not be created exclusively', { cause: error });
  }
  return token;
}

export function defaultDshHome(env: Record<string, string | undefined>): string {
  return env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : join(homeDir(), '.dsh');
}

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '.';
}

/** Resolve the effective configuration (defaults + token resolution). */
export function resolveConfig(
  input: BridgeConfigInput,
  env: Record<string, string | undefined>,
): ResolvedBridgeConfig {
  const dshHome = defaultDshHome(env);
  const transport = input.transport === 'stdio' ? 'stdio' : 'http';
  const authMode = input.authMode === 'none' ? 'none' : 'token';
  const host = input.host || '127.0.0.1';
  if (transport === 'http' && authMode === 'none' && !isLoopbackHost(host)) {
    throw new Error(`authMode none is only allowed for loopback HTTP listeners; refusing non-loopback host ${host}`);
  }
  const tokenEnv = input.authTokenEnv || 'DSH_CHATGPT_BRIDGE_TOKEN';
  const tokenFile = input.tokenFile && input.tokenFile !== '' ? input.tokenFile : join(dshHome, 'chatgpt-bridge.token');
  let authToken = input.authToken ?? '';
  if (authMode === 'token' && authToken === '') {
    authToken = env[tokenEnv] ?? '';
  }
  if (authMode === 'token' && authToken === '') {
    authToken = readStableTokenFile(tokenFile, true) ?? '';
  }
  if (authMode === 'token' && authToken === '') {
    authToken = createTokenFile(tokenFile);
  }
  return {
    mode: input.mode === 'advisor' ? 'advisor' : 'controller',
    transport,
    host,
    port: input.port ?? 3456,
    authMode,
    authToken,
    tokenFile,
    resultMaxChars: input.resultMaxChars ?? 8000,
    resultMaxItems: input.resultMaxItems ?? 50,
    sessionMaxItems: input.sessionMaxItems ?? 20,
    sessionMaxChars: input.sessionMaxChars ?? 4000,
    logLevel: input.logLevel ?? 'info',
    dshHome,
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
  };
}
