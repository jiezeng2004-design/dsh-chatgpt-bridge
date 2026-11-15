import type { ResolvedBridgeConfig } from '../config.js';
import type { BridgeLogger } from '../log.js';
import { AdvisorStore, advisorStateDir } from './state.js';

export interface AdvisorRuntime {
  store: AdvisorStore;
  close(): Promise<void>;
}

/** One plugin-owned store shared by all MCP sessions. null selects memory only. */
export function createAdvisorRuntime(
  cfg: ResolvedBridgeConfig,
  log?: BridgeLogger,
  options?: { dir?: string | null },
): AdvisorRuntime {
  const dir = options?.dir === undefined ? advisorStateDir(cfg.dshHome) : options.dir;
  const store = new AdvisorStore({
    ...(dir === null ? {} : { dir }),
    maxIterations: cfg.advisorMaxIterations ?? 12,
    ...(log === undefined ? {} : { logger: { warn: (message: string) => log.warn(message) } }),
  });
  return { store, close: () => store.close() };
}
