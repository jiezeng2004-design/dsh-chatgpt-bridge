import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from '../bridge.js';
import type { ResolvedBridgeConfig } from '../config.js';
import type { BridgeLogger } from '../log.js';
export declare const ADVISOR_FORBIDDEN_TOOL_NAMES: readonly ["dsh_create_session", "dsh_send_message", "dsh_cancel_task", "dsh_answer_question", "dsh_approve", "dsh_create_goal", "dsh_revise_goal", "dsh_pause_goal", "dsh_resume_goal", "dsh_retry_step", "dsh_rerun_step", "dsh_wait_until_action_required", "dsh_start_goal", "dsh_update_goal", "dsh_wait_goal", "dsh_stop_goal", "dsh_list_sessions", "dsh_get_session", "dsh_get_task_status", "dsh_get_result", "dsh_credential_status"];
export declare function registerAdvisorTools(server: McpServer, bridge: Bridge, cfg: ResolvedBridgeConfig, log: BridgeLogger): void;
