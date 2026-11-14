/**
 * dsh-chatgpt-bridge plugin entry: a DSH (Cordis) plugin row that mounts the
 * MCP bridge. Removing or disabling the row (or the bundle) makes the MCP
 * endpoint disappear while DSH keeps running untouched.
 */
import { Context } from '@deepseek-ai/cordis';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.js';
import { bridgeHttpUrl, ConfigSchema, resolveConfig } from './config.js';
import { createBridgeLogger, createControlLogger } from './log.js';
import { createMcpServer } from './mcp.js';
import { createAdvisorRuntime } from './advisor/runtime.js';
import { registerAdvisorAgentTools } from './advisor/agent-tools.js';
import { startHttpServer } from './http.js';
import { RuntimeManager } from './control/runtime-manager.js';
import { createManagementApi } from './control/routes.js';
export const name = 'chatgpt-bridge';
/** Core services the bridge needs before it can start. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionTitle', 'agentDefaultModel', 'loader'];
/** Plugin configuration schema (schemastery, DSH convention). */
export const Config = ConfigSchema;
export function apply(ctx, config) {
    const cfg = resolveConfig(config, process.env);
    const log = createBridgeLogger({
        level: cfg.logLevel,
        dshHome: cfg.dshHome,
        stdioSafe: cfg.transport === 'stdio',
        cordis: {
            info: (message) => ctx.logger.info(message),
            warn: (message) => ctx.logger.warn(message),
            error: (message) => ctx.logger.error(message),
        },
    });
    const bridge = new Bridge(ctx, cfg, log);
    const advisor = cfg.mode === 'advisor' ? createAdvisorRuntime(cfg, log) : undefined;
    registerAdvisorAgentTools(ctx, advisor, bridge, log);
    bridge.start();
    // v0.4.0 Control Plane: runtime manager + management API (web profile only).
    // Bridge stays the data plane; the manager only probes the bridge endpoint.
    const controlLog = createControlLogger(cfg.dshHome, {
        info: (message) => ctx.logger.info(message),
        warn: (message) => ctx.logger.warn(message),
        error: (message) => ctx.logger.error(message),
    });
    const runtimeManager = new RuntimeManager({
        dshHome: cfg.dshHome,
        bridge: {
            url: bridgeHttpUrl(cfg.host, cfg.port),
            token: cfg.authToken,
            authMode: cfg.authMode,
        },
        logger: controlLog,
    });
    runtimeManager.activate();
    const managementApi = createManagementApi(runtimeManager, { dshHome: cfg.dshHome });
    ctx.inject(['webServer'], (webCtx) => {
        if (webCtx.webServer === undefined)
            return () => { };
        const disposeApi = managementApi.register(webCtx.webServer);
        return () => disposeApi();
    });
    const mcpServer = createMcpServer(bridge, cfg, log, advisor);
    let stdioTransport;
    let stdioReady;
    let httpReady;
    if (cfg.transport === 'stdio') {
        log.info('MCP stdio transport active — speak JSON-RPC on stdin/stdout');
        stdioTransport = new StdioServerTransport();
        stdioReady = mcpServer.connect(stdioTransport).catch((error) => {
            log.error(`stdio transport failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    else {
        httpReady = startHttpServer(() => createMcpServer(bridge, cfg, log, advisor), { host: cfg.host, port: cfg.port, authMode: cfg.authMode, authToken: cfg.authToken }, log);
        void httpReady.catch((error) => {
            log.error(`failed to start MCP HTTP server: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    // Fiber-owned effect: Cordis awaits this disposer, so the MCP endpoint is
    // actually gone before the plugin row finishes unloading.
    ctx.effect(() => async () => {
        log.info('bridge shutting down: closing MCP server and transports');
        // v0.4.0: stop the plugin-owned tunnel-client (if any) before teardown so
        // DSH unload never leaves an orphan tunnel runtime.
        await runtimeManager.dispose();
        if (httpReady !== undefined) {
            try {
                const handle = await httpReady;
                try {
                    await handle.close();
                }
                catch (error) {
                    log.error(`http server close failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            catch {
                // start already logged; nothing listening
            }
        }
        if (stdioReady !== undefined) {
            try {
                await stdioReady;
            }
            catch {
                // connect already logged
            }
        }
        if (stdioTransport !== undefined) {
            try {
                await stdioTransport.close();
            }
            catch {
                // best-effort
            }
        }
        try {
            await mcpServer.close();
        }
        catch {
            // best-effort
        }
        try {
            await advisor?.close();
        }
        catch {
            // best-effort
        }
    });
}
