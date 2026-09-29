/**
 * dsh-chatgpt-bridge plugin entry: a DSH (Cordis) plugin row that mounts the
 * MCP bridge. Removing or disabling the row (or the bundle) makes the MCP
 * endpoint disappear while DSH keeps running untouched.
 */
import { Context } from '@deepseek-ai/cordis';
import { type BridgeConfigInput } from './config.js';
export declare const name = "chatgpt-bridge";
/** Core services the bridge needs before it can start. */
export declare const inject: string[];
/** Plugin configuration schema (schemastery, DSH convention). */
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
    transport: import("@deepseek-ai/schemastery").default<"http" | "stdio", "http" | "stdio", "defined">;
    host: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    port: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    authMode: import("@deepseek-ai/schemastery").default<"token" | "none", "token" | "none", "defined">;
    authToken: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    authTokenEnv: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    tokenFile: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    resultMaxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    resultMaxItems: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    sessionMaxItems: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    sessionMaxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    logLevel: import("@deepseek-ai/schemastery").default<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn", "defined">;
    approvalPolicy: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        read: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        test: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        build: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        workspaceWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        localCommit: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        externalWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        gitPush: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        npmPublish: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        githubRelease: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        secrets: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask", "defined">;
        dangerFullAccess: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask", "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        read: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        test: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        build: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        workspaceWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        localCommit: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        externalWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        gitPush: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        npmPublish: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        githubRelease: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        secrets: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask", "defined">;
        dangerFullAccess: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask", "defined">;
    }>>, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    transport: import("@deepseek-ai/schemastery").default<"http" | "stdio", "http" | "stdio", "defined">;
    host: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    port: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    authMode: import("@deepseek-ai/schemastery").default<"token" | "none", "token" | "none", "defined">;
    authToken: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    authTokenEnv: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    tokenFile: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    resultMaxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    resultMaxItems: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    sessionMaxItems: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    sessionMaxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    logLevel: import("@deepseek-ai/schemastery").default<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn", "defined">;
    approvalPolicy: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        read: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        test: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        build: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        workspaceWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        localCommit: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        externalWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        gitPush: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        npmPublish: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        githubRelease: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        secrets: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask", "defined">;
        dangerFullAccess: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask", "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        read: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        test: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        build: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        workspaceWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        localCommit: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        externalWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        gitPush: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        npmPublish: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        githubRelease: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask", "defined">;
        secrets: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask", "defined">;
        dangerFullAccess: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask", "defined">;
    }>>, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: BridgeConfigInput): void;
