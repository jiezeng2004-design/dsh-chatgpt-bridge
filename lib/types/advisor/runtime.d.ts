import type { ResolvedBridgeConfig } from '../config.js';
import type { BridgeLogger } from '../log.js';
import { AdvisorStore } from './state.js';
export interface AdvisorRuntime {
    store: AdvisorStore;
    close(): Promise<void>;
}
/** One plugin-owned store shared by all MCP sessions. null selects memory only. */
export declare function createAdvisorRuntime(cfg: ResolvedBridgeConfig, log?: BridgeLogger, options?: {
    dir?: string | null;
}): AdvisorRuntime;
