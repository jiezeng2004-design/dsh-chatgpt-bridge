import { AdvisorStore, advisorStateDir } from './state.js';
/** One plugin-owned store shared by all MCP sessions. null selects memory only. */
export function createAdvisorRuntime(cfg, log, options) {
    const dir = options?.dir === undefined ? advisorStateDir(cfg.dshHome) : options.dir;
    const store = new AdvisorStore({
        ...(dir === null ? {} : { dir }),
        maxIterations: cfg.advisorMaxIterations ?? 12,
        ...(log === undefined ? {} : { logger: { warn: (message) => log.warn(message) } }),
    });
    return { store, close: () => store.close() };
}
