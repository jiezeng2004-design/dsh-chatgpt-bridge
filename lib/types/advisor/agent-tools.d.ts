import type { Context } from '@deepseek-ai/cordis';
import { type Bridge } from '../bridge.js';
import type { BridgeLogger } from '../log.js';
import type { AdvisorRuntime } from './runtime.js';
/** Undefined runtime is the controller-mode guard: no imports or injections. */
export declare function registerAdvisorAgentTools(ctx: Context, runtime: AdvisorRuntime | undefined, bridge: Bridge, log: BridgeLogger): void;
