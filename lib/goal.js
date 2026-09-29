import { foldRevisionHistory, goalCardLabel, revisionBanner } from './goal-control.js';
import { parseExecutionMode } from './goal-constraints.js';
export const DEFAULT_WAIT_SECONDS = 25;
export const MIN_WAIT_SECONDS = 1;
export const MAX_WAIT_SECONDS = 30;
export const WAIT_POLL_MS = 500;
export const REQUEST_ID_CAP = 256;
export const GOAL_SUMMARY_MAX_CHARS = 4000;
export const GOAL_FILES_MAX = 40;
export const GOAL_TODOS_MAX = 40;
export const OBSERVE_STATE_CAP = 256;
const GOAL_MODE = [
    'Goal execution mode:',
    '- Treat the supplied goal as the completion target.',
    '- Use DSH native todos to track progress. After a real tool action succeeds, update the matching todo immediately.',
    '- Continue working through remaining todos without waiting for ChatGPT between ordinary engineering steps.',
    '- If one independent branch is blocked, continue other runnable branches; do not freeze the whole goal.',
    '- Pause only for user questions, approvals, explicit errors, cancellation, or when the goal is complete.',
    '- Do not expand scope beyond the supplied goal.',
].join('\n');
/** Injected into every ChatGPT Bridge supervised Agent turn. Native get_goal is a different namespace. */
export const SUPERVISED_GOAL_AUTHORITY = [
    'This session is executing a ChatGPT Bridge supervised Goal.',
    'The injected [Goal] block is the authoritative current Goal state,',
    'including goal_id, revision, execution mode and constraints.',
    'Do not call the agent-native get_goal tool to rediscover or validate this supervised Goal.',
    'A null result from native get_goal does NOT mean the supervised Goal does not exist and must never override the injected Goal state.',
].join('\n');
export function clampWaitSeconds(value) {
    if (value === undefined || !Number.isFinite(value))
        return DEFAULT_WAIT_SECONDS;
    const n = Math.trunc(value);
    if (n < MIN_WAIT_SECONDS)
        return MIN_WAIT_SECONDS;
    if (n > MAX_WAIT_SECONDS)
        return MAX_WAIT_SECONDS;
    return n;
}
export function buildGoalMessage(goal, plan, options) {
    const lines = [`Goal:\n${goal.trim()}`];
    if (plan !== undefined && plan.trim() !== '')
        lines.push(`Plan:\n${plan.trim()}`);
    if (options?.revision !== undefined)
        lines.push(`Goal revision: ${options.revision}`);
    const mode = parseExecutionMode(options?.mode);
    if (mode === 'minimal') {
        lines.push([
            'Execution mode: minimal',
            '- Only perform actions that are strictly required to complete the goal.',
            '- Do not scan the workspace, snapshot files, hash the tree, write extra reports, or run unsolicited verification.',
            '- Do not call the agent-native get_goal tool; it is an unnecessary control-plane query in this mode.',
            '- A null native get_goal result is not a missing Goal and must not change this supervised Goal.',
        ].join('\n'));
    }
    else if (mode === 'strict') {
        lines.push([
            'Execution mode: strict',
            '- Follow the supplied plan and constraints exactly. Do not expand scope.',
        ].join('\n'));
    }
    lines.push(GOAL_MODE);
    if (options?.constraints !== undefined && Object.keys(options.constraints).length > 0) {
        lines.push(`Constraints (must not violate):\n${JSON.stringify(options.constraints)}`);
    }
    if (options?.completedKinds !== undefined && options.completedKinds.length > 0) {
        lines.push('Already completed — do not repeat these destructive actions:\n'
            + options.completedKinds.map((kind) => `- ${kind}`).join('\n'));
    }
    if (options?.deferredSteps !== undefined && options.deferredSteps.length > 0) {
        lines.push('Deferred steps (do not run now):\n' + options.deferredSteps.map((step) => `- ${step}`).join('\n'));
    }
    if (options?.resumeSteps !== undefined && options.resumeSteps.length > 0) {
        lines.push('Resume these steps now:\n' + options.resumeSteps.map((step) => `- ${step}`).join('\n'));
    }
    if (options?.intent === 'resume') {
        lines.push('Resume the existing goal. Do not restart completed work.');
    }
    return lines.join('\n\n');
}
export function foldedGoalDisplay(record) {
    const card = goalCardLabel(record);
    const history = foldRevisionHistory(record);
    if (history.length <= 1) {
        return `Display this as a single Goal card: "${card}". This is one supervised Goal, not multiple agents.`;
    }
    const trail = history
        .map((item) => `rev${item.revision} (${item.revision_reason})`)
        .join(' → ');
    return [
        `Display this as a single Goal card: "${card}".`,
        `Revision history rev 1→${record.revision} is folded under that card; this is not a new session, agent, or Goal.`,
        `Folded history: ${trail}.`,
    ].join('\n');
}
/** Full Agent-turn payload: [Goal] banner + authority rules + goal/plan/mode. */
export function buildSupervisedGoalContext(record, goal, plan, intent, resumeSteps) {
    return [
        revisionBanner(record),
        foldedGoalDisplay(record),
        SUPERVISED_GOAL_AUTHORITY,
        `Supervised identity: goal_id=${record.goal_id} revision=${record.revision} mode=${record.mode}.`,
        buildGoalMessage(goal, plan, {
            mode: record.mode,
            constraints: record.constraints,
            completedKinds: record.completed_action_kinds,
            deferredSteps: record.deferred_step_ids,
            ...(resumeSteps === undefined || resumeSteps.length === 0 ? {} : { resumeSteps }),
            revision: record.revision,
            intent,
        }),
    ].join('\n\n');
}
export function executionView(graph, currentStep) {
    return {
        ...(currentStep === undefined || currentStep === '' ? {} : { current_step: currentStep }),
        runnable_steps: [...graph.remaining_runnable_steps],
        blocked_steps: [...graph.blocked_steps],
        deferred_steps: [...graph.deferred_steps],
    };
}
export function titleFromGoal(goal) {
    const line = goal.trim().split(/\r?\n/, 1)[0] ?? '';
    if (line.length <= 80)
        return line;
    return line.slice(0, 79) + '…';
}
export function fingerprintStart(input) {
    return JSON.stringify({
        workspace: input.workspace,
        goal: input.goal,
        plan: input.plan ?? '',
        session_id: input.session_id ?? '',
        execution_mode: input.execution_mode ?? '',
        constraints: input.constraints ?? null,
        action: input.action ?? '',
    });
}
/** Only these statuses keep the Goal wait loop alive. Never treat idle as running. */
export function isActiveStatus(status) {
    return status === 'running' || status === 'queued';
}
export function isTerminalStatus(status) {
    return (status === 'completed'
        || status === 'failed'
        || status === 'cancelled'
        || status === 'blocked'
        || status === 'max-tokens'
        || status === 'interrupted'
        || status === 'forked');
}
export function isWaitingStatus(status) {
    return status === 'waiting_for_approval' || status === 'waiting_for_user';
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + '…[truncated]';
}
function boundedTodos(todos) {
    return (todos ?? []).slice(0, GOAL_TODOS_MAX);
}
function boundedFiles(files) {
    return files.slice(0, GOAL_FILES_MAX);
}
function progressOf(snapshot) {
    const todos = boundedTodos(snapshot.todos);
    return {
        todos,
        todos_completed: todos.filter((todo) => todo.status === 'completed').length,
        todos_total: todos.length,
        ...(snapshot.agentStatus === undefined ? {} : { agent_status: snapshot.agentStatus }),
        ...(snapshot.lastActivity === undefined ? {} : { last_activity: snapshot.lastActivity }),
        ...(snapshot.lastTurn === undefined ? {} : { last_turn: snapshot.lastTurn }),
        changed_files: boundedFiles(snapshot.changedFiles),
        ...(snapshot.errorSummary === undefined || snapshot.errorSummary === ''
            ? {}
            : { error_summary: truncate(snapshot.errorSummary, 500) }),
    };
}
function extrasOf(snapshot) {
    return {
        ...(snapshot.progressDelta === undefined ? {} : { progress_delta: snapshot.progressDelta }),
        ...(snapshot.blocked === undefined ? {} : { blocked: snapshot.blocked }),
        ...(snapshot.deferredSteps === undefined || snapshot.deferredSteps.length === 0
            ? {}
            : { deferred_steps: snapshot.deferredSteps }),
        ...(snapshot.blockedSteps === undefined || snapshot.blockedSteps.length === 0
            ? {}
            : { blocked_steps: snapshot.blockedSteps }),
        ...(snapshot.remainingRunnableSteps === undefined || snapshot.remainingRunnableSteps.length === 0
            ? {}
            : { remaining_runnable_steps: snapshot.remainingRunnableSteps }),
        ...(snapshot.cleanupWarning === undefined || snapshot.cleanupWarning === ''
            ? {}
            : { cleanup_warning: snapshot.cleanupWarning }),
        ...(snapshot.goal === undefined ? {} : { goal: snapshot.goal }),
        ...(snapshot.execution === undefined ? {} : { execution: snapshot.execution }),
        ...(snapshot.history === undefined || snapshot.history.length === 0 ? {} : { history: snapshot.history }),
    };
}
/** blocked is only a wait-loop terminal when no independent branch remains. */
export function isWaitTerminal(status, remainingRunnableSteps) {
    if (status === 'blocked' && (remainingRunnableSteps?.length ?? 0) > 0)
        return false;
    return isTerminalStatus(status);
}
export function mapStartGoal(sessionId, status, waitSeconds = DEFAULT_WAIT_SECONDS, extras) {
    const extraFields = {
        ...(extras?.goal === undefined ? {} : { goal: extras.goal }),
        ...(extras?.execution === undefined ? {} : { execution: extras.execution }),
        ...(extras?.history === undefined || extras.history.length === 0 ? {} : { history: extras.history }),
    };
    const active = isActiveStatus(status);
    if (active) {
        return {
            session_id: sessionId,
            status,
            continuation_required: true,
            next_action: 'Continue supervising this DSH goal. Call dsh_wait_goal immediately in this assistant turn.',
            next_tool_call: {
                name: 'dsh_wait_goal',
                arguments: { session_id: sessionId, wait_seconds: waitSeconds },
            },
            ...extraFields,
        };
    }
    if (isWaitingStatus(status)) {
        return {
            session_id: sessionId,
            status,
            continuation_required: false,
            next_action: status === 'waiting_for_approval'
                ? 'DSH is waiting for an explicit approval. Ask the user, then call dsh_approve, then dsh_wait_goal.'
                : 'DSH is waiting for the user. Ask the user, then call dsh_answer_question, then dsh_wait_goal.',
            ...extraFields,
        };
    }
    return {
        session_id: sessionId,
        status,
        continuation_required: false,
        next_action: isTerminalStatus(status)
            ? 'The DSH goal is already terminal. Inspect the session or start a new goal.'
            : 'The DSH session is idle. Send a goal or message before waiting.',
        ...extraFields,
    };
}
export function mapWaitGoal(snapshot) {
    const { sessionId, status, waitedMs, waitSeconds } = snapshot;
    const extras = extrasOf(snapshot);
    if (isActiveStatus(status)) {
        return {
            session_id: sessionId,
            status,
            terminal: false,
            waited_ms: waitedMs,
            continuation_required: true,
            progress: progressOf(snapshot),
            next_action: 'DSH is still working. Call dsh_wait_goal again immediately in this assistant turn; do not tell the user the task is merely running in the background.',
            next_tool_call: {
                name: 'dsh_wait_goal',
                arguments: { session_id: sessionId, wait_seconds: waitSeconds },
            },
            ...extras,
        };
    }
    if (status === 'waiting_for_approval') {
        return {
            session_id: sessionId,
            status,
            terminal: false,
            waited_ms: waitedMs,
            continuation_required: false,
            needs_user_action: true,
            ...(snapshot.approval === undefined ? {} : { approval: snapshot.approval }),
            progress: progressOf(snapshot),
            next_action: 'DSH is waiting for approval. Ask the user, then call dsh_approve with the exact approval_id, then call dsh_wait_goal. Do not auto-approve.',
            ...extras,
        };
    }
    if (status === 'waiting_for_user') {
        return {
            session_id: sessionId,
            status,
            terminal: false,
            waited_ms: waitedMs,
            continuation_required: false,
            needs_user_action: true,
            ...(snapshot.question === undefined ? {} : { question: snapshot.question }),
            progress: progressOf(snapshot),
            next_action: 'DSH is waiting for the user. Ask the user, then call dsh_answer_question, then call dsh_wait_goal. Do not guess the answer.',
            ...extras,
        };
    }
    if (status === 'blocked' && !isWaitTerminal(status, snapshot.remainingRunnableSteps)) {
        return {
            session_id: sessionId,
            status,
            terminal: false,
            waited_ms: waitedMs,
            continuation_required: false,
            progress: progressOf(snapshot),
            next_action: 'One Goal branch is blocked but independent steps remain. Re-arm with dsh_start_goal on this session_id '
                + '(defer the blocked step if needed) to continue remaining_runnable_steps. Do not treat the whole Goal as finished.',
            ...extras,
        };
    }
    if (isTerminalStatus(status)) {
        return {
            session_id: sessionId,
            status,
            terminal: true,
            waited_ms: waitedMs,
            continuation_required: false,
            result: {
                summary: truncate(snapshot.assistantSummary, GOAL_SUMMARY_MAX_CHARS),
                changed_files: boundedFiles(snapshot.changedFiles),
                todos: boundedTodos(snapshot.todos),
            },
            ...(snapshot.errorSummary === undefined || snapshot.errorSummary === ''
                ? {}
                : { progress: progressOf(snapshot) }),
            next_action: status === 'completed'
                ? 'The DSH goal is complete. Review the returned result.'
                : `The DSH goal ended (${status}). Review the returned result; do not keep calling dsh_wait_goal.`,
            ...extras,
        };
    }
    return {
        session_id: sessionId,
        status,
        terminal: false,
        waited_ms: waitedMs,
        continuation_required: false,
        progress: progressOf(snapshot),
        next_action: 'The DSH session is idle. Do not loop dsh_wait_goal; send a new goal or message if more work is needed.',
        ...extras,
    };
}
/** FIFO-capped in-memory request_id map. Not durable across process restarts. */
export class RequestIdMap {
    items = new Map();
    cap;
    constructor(cap = REQUEST_ID_CAP) {
        this.cap = cap;
    }
    get(requestId) {
        return this.items.get(requestId);
    }
    set(requestId, record) {
        if (this.items.has(requestId))
            this.items.delete(requestId);
        this.items.set(requestId, record);
        while (this.items.size > this.cap) {
            const first = this.items.keys().next().value;
            if (first === undefined)
                break;
            this.items.delete(first);
        }
    }
}
export class GoalObserveMap {
    items = new Map();
    cap;
    constructor(cap = OBSERVE_STATE_CAP) {
        this.cap = cap;
    }
    get(sessionId) {
        return this.items.get(sessionId);
    }
    set(sessionId, state) {
        if (this.items.has(sessionId))
            this.items.delete(sessionId);
        this.items.set(sessionId, state);
        while (this.items.size > this.cap) {
            const first = this.items.keys().next().value;
            if (first === undefined)
                break;
            this.items.delete(first);
        }
    }
}
