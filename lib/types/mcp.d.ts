/**
 * MCP server surface: data-plane and control-plane dsh_* tools ChatGPT calls.
 * Every tool maps onto a Bridge operation; nothing here reaches the filesystem,
 * the shell, or DSH internals directly. Outputs are JSON text blocks; failures
 * are reported as isError results with { error: { code, message } }.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Bridge } from './bridge.js';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import type { AdvisorRuntime } from './advisor/runtime.js';
type TextResult = {
    content: {
        type: 'text';
        text: string;
    }[];
    structuredContent?: Record<string, unknown>;
    isError?: true;
};
/**
 * Successful result: redacted JSON text (kept for backward compatibility) plus,
 * for plain-object values, the identical redacted object as structuredContent.
 * No tool declares an outputSchema, so the SDK performs no validation on it.
 */
export declare function textResult(value: unknown): TextResult;
export declare function errorResult(error: unknown): TextResult & {
    isError: true;
};
/** Wrap one async handler into the MCP error convention. */
export declare function safe<A>(handler: (args: A) => Promise<unknown>): (args: A) => Promise<TextResult>;
interface ToolBehavior {
    readOnly: boolean;
    /** Only meaningful for writes: may overwrite/cancel/approve in a way that is hard to undo. */
    destructive: boolean;
    idempotent: boolean;
    /** True when the tool starts or continues agent work that may touch the network/filesystem. */
    openWorld: boolean;
}
/**
 * Single audit table for MCP tool annotations. ChatGPT uses these hints to
 * decide whether to ask the user before calling a tool. Every registered tool
 * must have an entry (toolAnnotations throws otherwise).
 */
export declare const TOOL_BEHAVIOR: Record<string, ToolBehavior>;
export declare function toolAnnotations(name: string): {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
};
export declare function createMcpServer(bridge: Bridge, cfg: ResolvedBridgeConfig, log: BridgeLogger, advisor?: AdvisorRuntime): McpServer;
export {};
