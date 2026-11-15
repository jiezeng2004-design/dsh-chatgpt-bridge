import type { Context } from '@deepseek-ai/cordis';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { type BridgeStatus } from './status.js';
import type { ExecutionSupervisionView, GoalStartResult, GoalWaitResult } from './goal.js';
import type { BlockedInfo } from './goal-graph.js';
import { type GoalHistoryEvent, type GoalSupervisionView } from './goal-control.js';
import type { ExecutionMode, GoalConstraints } from './goal-constraints.js';
import { type UserApprovalPolicy } from './approval-policy.js';
import { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { ExecutionIdempotencyManager } from './execution-idempotency.js';
import { type ResultSchema, type CredentialStatus } from './result-schema.js';
import { type ApprovalLayer, type ApprovalRequestLike, type HealthReport, type ResultView, type SessionSummary, type SessionView, type WaitingState, type WorkspaceView } from './bridge-types.js';
import { type StartGoalInput, type UpdateGoalInput } from './bridge-goal-lifecycle.js';
export { normalizePath } from './paths.js';
export { BridgeError } from './bridge-types.js';
export type { ApprovalLayer, ApprovalRequestLike, ApprovalSummary, HealthReport, PendingApproval, PendingQuestion, QuestionSummary, ResultView, SessionSummary, SessionView, WaitingState, WorkspaceView, } from './bridge-types.js';
export type { StartGoalInput, UpdateGoalInput } from './bridge-goal-lifecycle.js';
export { dshVersion } from './bridge-helpers.js';
/** The bridge service. One instance per plugin activation. */
export declare class Bridge {
    private readonly ctx;
    private readonly cfg;
    private readonly log;
    /** Sessions created through this bridge (approval answering scope). */
    private readonly managed;
    private readonly approvals;
    private readonly questions;
    private readonly goalStore;
    private apiProxy;
    private readonly workspace;
    private readonly broker;
    private readonly observer;
    private readonly lifecycle;
    readonly workspaceGuard: WorkspaceConcurrencyGuard;
    readonly idempotencyManager: ExecutionIdempotencyManager;
    approvalPolicy: UserApprovalPolicy;
    /** Test hooks for bounded wait loops. */
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    constructor(ctx: Context, cfg: ResolvedBridgeConfig, log: BridgeLogger);
    /** Register the approval answerer and the user-questions provider. */
    start(): void;
    private adopt;
    /** Count of bridge-created sessions still live. */
    managedCount(): number;
    private agentOptions;
    /**
     * DSH 0.2.2 owns model selection on the Agent (`agent.model`): resumes keep
     * the recorded choice and fall back to the live `agentOptions()` route. The
     * bridge never selects a model itself; it only installs the scoped
     * model-switch notice listener.
     */
    private installSelection;
    /** Compose the preset+selection setup used at agent creation/resume. */
    private composeSetupFor;
    private loadView;
    /** Resolve a live agent, resuming the persisted session when needed. */
    private ensureAgent;
    listWorkspaces(): Promise<WorkspaceView[]>;
    /**
     * Resolve a workspace reference (id, canonical path, or title) against the
     * REGISTERED workspace set only. Never auto-registers and never opens an
     * arbitrary path: an unregistered path is rejected.
     */
    resolveWorkspace(input: string): Promise<Workspace>;
    health(): Promise<HealthReport>;
    createSession(workspaceInput: string, title?: string, initialMessage?: string): Promise<SessionView>;
    sendMessage(sessionId: string, message: string): Promise<{
        session_id: string;
        accepted: boolean;
    }>;
    cancelTask(sessionId: string): Promise<{
        session_id: string;
        cancelled: boolean;
    }>;
    private waitingFor;
    private statusOf;
    private titleOf;
    private viewOf;
    getSession(sessionId: string, maxItems?: number, maxChars?: number): Promise<SessionView>;
    listSessions(options: {
        limit?: number;
        offset?: number;
        workspace?: string;
    }): Promise<SessionSummary[]>;
    /** Zero-I/O cached title for a cold session, when a projection cache is mounted. */
    private cachedTitle;
    getResult(sessionId: string, maxChars?: number): Promise<ResultView>;
    getTaskStatus(sessionId: string): Promise<{
        session_id: string;
        status: BridgeStatus;
        live: boolean;
        agent_status?: 'idle' | 'running';
        pending: {
            nextTurn: number;
            nextStep: number;
        };
        waiting: WaitingState;
        last_turn?: {
            turn: number;
            reason?: string;
        };
        updated_at?: string;
        todos?: {
            content: string;
            status: string;
        }[];
        blocked?: BlockedInfo;
        deferred_steps?: string[];
        blocked_steps?: string[];
        remaining_runnable_steps?: string[];
        goal?: GoalSupervisionView;
        execution?: ExecutionSupervisionView;
        history?: GoalHistoryEvent[];
    }>;
    createGoal(input: {
        workspace: string;
        goal: string;
        plan?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        request_id?: string;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    reviseGoal(input: {
        session_id: string;
        goal?: string;
        plan?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        expected_revision?: number;
        revision_reason?: string;
        request_id?: string;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    pauseGoal(sessionId: string): Promise<{
        session_id: string;
        status: BridgeStatus;
        paused: boolean;
        checkpoint_revision: number;
    }>;
    resumeGoal(sessionId: string, resumeSteps?: string[], requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    retryStep(sessionId: string, stepId: string, requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    rerunStep(sessionId: string, stepId: string, requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    waitUntilActionRequired(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult>;
    getStructuredResult(sessionId: string): Promise<ResultSchema>;
    getCredentialStatus(): CredentialStatus[];
    startGoal(input: StartGoalInput): Promise<GoalStartResult>;
    updateGoal(input: UpdateGoalInput): Promise<GoalStartResult>;
    waitGoal(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult>;
    stopGoal(sessionId: string): Promise<{
        session_id: string;
        stopped: true;
        already_stopped: boolean;
        status: BridgeStatus;
        cleanup_warning?: string;
    }>;
    private noteGoalEvent;
    /**
     * Decide a DSH approval/request for a managed session.
     * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
     * deny/reject always remain reachable even if approve is blocked.
     */
    decideApproval(request: ApprovalRequestLike, next?: () => Promise<ApprovalOutcome> | ApprovalOutcome): Promise<ApprovalOutcome>;
    answerQuestion(questionId: string, sessionId: string | undefined, answer: {
        selected: string[];
        custom?: string;
    }): Promise<{
        answered: true;
    }>;
    approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<{
        approval_id: string;
        session_id: string;
        decision: 'approve' | 'reject';
        outcome: ApprovalOutcome;
        layer: ApprovalLayer;
        fail_closed?: boolean;
    }>;
    listManaged(): string[];
}
