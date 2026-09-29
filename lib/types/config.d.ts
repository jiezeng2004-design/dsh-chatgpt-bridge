import z from '@deepseek-ai/schemastery';
import type { LogLevel } from './log.js';
/**
 * Plugin configuration (schemastery schema, DSH convention). All defaults are
 * security-first: loopback-only host, bearer-token auth, bounded result sizes.
 */
export declare const ConfigSchema: z<Schemastery.ObjectS<NoInfer<{
    /** MCP transport: 'http' (Streamable HTTP) or 'stdio' (local MCP clients). */
    transport: z<"http" | "stdio", "http" | "stdio", "defined">;
    /** Bind host for the Streamable HTTP server. Loopback only by default. */
    host: z<string, string, "defined">;
    /** Bind port for the Streamable HTTP server. */
    port: z<number, number, "defined">;
    /** 'token' requires Authorization: Bearer <token>; 'none' disables auth (loopback only, not recommended). */
    authMode: z<"token" | "none", "token" | "none", "defined">;
    /** Static token; empty falls back to authTokenEnv, then a generated token persisted to tokenFile. */
    authToken: z<string, string, "defined">;
    /** Environment variable read when authToken is empty. */
    authTokenEnv: z<string, string, "defined">;
    /** Where a generated token is persisted; empty means $DSH_HOME/chatgpt-bridge.token. */
    tokenFile: z<string, string, "defined">;
    /** Max characters of assistant text returned by dsh_get_result. */
    resultMaxChars: z<number, number, "defined">;
    /** Max tool calls returned by dsh_get_result. */
    resultMaxItems: z<number, number, "defined">;
    /** Max message rows returned by dsh_get_session. */
    sessionMaxItems: z<number, number, "defined">;
    /** Max characters per message text returned by dsh_get_session. */
    sessionMaxChars: z<number, number, "defined">;
    /** Log verbosity: debug | info | warn | error. */
    logLevel: z<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn", "defined">;
    /** Risk-tiered auto-approval policy. Omitted fields keep the safe defaults. */
    approvalPolicy: z<Schemastery.ObjectS<NoInfer<{
        read: z<"auto" | "ask", "auto" | "ask", "defined">;
        test: z<"auto" | "ask", "auto" | "ask", "defined">;
        build: z<"auto" | "ask", "auto" | "ask", "defined">;
        workspaceWrite: z<"auto" | "ask", "auto" | "ask", "defined">;
        localCommit: z<"auto" | "ask", "auto" | "ask", "defined">;
        externalWrite: z<"auto" | "ask", "auto" | "ask", "defined">;
        gitPush: z<"auto" | "ask", "auto" | "ask", "defined">;
        npmPublish: z<"auto" | "ask", "auto" | "ask", "defined">;
        githubRelease: z<"auto" | "ask", "auto" | "ask", "defined">;
        secrets: z<"deny" | "ask", "deny" | "ask", "defined">;
        dangerFullAccess: z<"deny" | "ask", "deny" | "ask", "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        read: z<"auto" | "ask", "auto" | "ask", "defined">;
        test: z<"auto" | "ask", "auto" | "ask", "defined">;
        build: z<"auto" | "ask", "auto" | "ask", "defined">;
        workspaceWrite: z<"auto" | "ask", "auto" | "ask", "defined">;
        localCommit: z<"auto" | "ask", "auto" | "ask", "defined">;
        externalWrite: z<"auto" | "ask", "auto" | "ask", "defined">;
        gitPush: z<"auto" | "ask", "auto" | "ask", "defined">;
        npmPublish: z<"auto" | "ask", "auto" | "ask", "defined">;
        githubRelease: z<"auto" | "ask", "auto" | "ask", "defined">;
        secrets: z<"deny" | "ask", "deny" | "ask", "defined">;
        dangerFullAccess: z<"deny" | "ask", "deny" | "ask", "defined">;
    }>>, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** MCP transport: 'http' (Streamable HTTP) or 'stdio' (local MCP clients). */
    transport: z<"http" | "stdio", "http" | "stdio", "defined">;
    /** Bind host for the Streamable HTTP server. Loopback only by default. */
    host: z<string, string, "defined">;
    /** Bind port for the Streamable HTTP server. */
    port: z<number, number, "defined">;
    /** 'token' requires Authorization: Bearer <token>; 'none' disables auth (loopback only, not recommended). */
    authMode: z<"token" | "none", "token" | "none", "defined">;
    /** Static token; empty falls back to authTokenEnv, then a generated token persisted to tokenFile. */
    authToken: z<string, string, "defined">;
    /** Environment variable read when authToken is empty. */
    authTokenEnv: z<string, string, "defined">;
    /** Where a generated token is persisted; empty means $DSH_HOME/chatgpt-bridge.token. */
    tokenFile: z<string, string, "defined">;
    /** Max characters of assistant text returned by dsh_get_result. */
    resultMaxChars: z<number, number, "defined">;
    /** Max tool calls returned by dsh_get_result. */
    resultMaxItems: z<number, number, "defined">;
    /** Max message rows returned by dsh_get_session. */
    sessionMaxItems: z<number, number, "defined">;
    /** Max characters per message text returned by dsh_get_session. */
    sessionMaxChars: z<number, number, "defined">;
    /** Log verbosity: debug | info | warn | error. */
    logLevel: z<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn", "defined">;
    /** Risk-tiered auto-approval policy. Omitted fields keep the safe defaults. */
    approvalPolicy: z<Schemastery.ObjectS<NoInfer<{
        read: z<"auto" | "ask", "auto" | "ask", "defined">;
        test: z<"auto" | "ask", "auto" | "ask", "defined">;
        build: z<"auto" | "ask", "auto" | "ask", "defined">;
        workspaceWrite: z<"auto" | "ask", "auto" | "ask", "defined">;
        localCommit: z<"auto" | "ask", "auto" | "ask", "defined">;
        externalWrite: z<"auto" | "ask", "auto" | "ask", "defined">;
        gitPush: z<"auto" | "ask", "auto" | "ask", "defined">;
        npmPublish: z<"auto" | "ask", "auto" | "ask", "defined">;
        githubRelease: z<"auto" | "ask", "auto" | "ask", "defined">;
        secrets: z<"deny" | "ask", "deny" | "ask", "defined">;
        dangerFullAccess: z<"deny" | "ask", "deny" | "ask", "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        read: z<"auto" | "ask", "auto" | "ask", "defined">;
        test: z<"auto" | "ask", "auto" | "ask", "defined">;
        build: z<"auto" | "ask", "auto" | "ask", "defined">;
        workspaceWrite: z<"auto" | "ask", "auto" | "ask", "defined">;
        localCommit: z<"auto" | "ask", "auto" | "ask", "defined">;
        externalWrite: z<"auto" | "ask", "auto" | "ask", "defined">;
        gitPush: z<"auto" | "ask", "auto" | "ask", "defined">;
        npmPublish: z<"auto" | "ask", "auto" | "ask", "defined">;
        githubRelease: z<"auto" | "ask", "auto" | "ask", "defined">;
        secrets: z<"deny" | "ask", "deny" | "ask", "defined">;
        dangerFullAccess: z<"deny" | "ask", "deny" | "ask", "defined">;
    }>>, "defined">;
}>>, "plain">;
import type { UserApprovalPolicy } from './approval-policy.js';
/** Input shape accepted from the cordis row config (schema input side). */
export interface BridgeConfigInput {
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
export declare function normalizeSocketHostname(host: string): string;
/** True only for listener hosts whose bind scope is loopback-only. */
export declare function isLoopbackHost(host: string): boolean;
/** Select a concrete address that can reach a wildcard listener locally. */
export declare function bridgeConnectHost(listenerHost: string): string;
/** Build a syntactically valid local probe URL, including IPv6 brackets. */
export declare function bridgeHttpUrl(listenerHost: string, port: number): string;
export declare function defaultDshHome(env: Record<string, string | undefined>): string;
/** Resolve the effective configuration (defaults + token resolution). */
export declare function resolveConfig(input: BridgeConfigInput, env: Record<string, string | undefined>): ResolvedBridgeConfig;
