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
export declare function textResult(value: unknown): {
    content: {
        type: 'text';
        text: string;
    }[];
};
export declare function errorResult(error: unknown): {
    content: {
        type: 'text';
        text: string;
    }[];
    isError: true;
};
/** Wrap one async handler into the MCP error convention. */
export declare function safe<A>(handler: (args: A) => Promise<unknown>): (args: A) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError?: true;
}>;
export declare function createMcpServer(bridge: Bridge, cfg: ResolvedBridgeConfig, log: BridgeLogger, advisor?: AdvisorRuntime): McpServer;
