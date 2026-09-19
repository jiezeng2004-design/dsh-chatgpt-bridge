import type { Context } from '@deepseek-ai/cordis';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'agent-preset/selected': {
            agentPreset: string;
        };
    }
}
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { type BridgeStatus } from './status.js';
import { type MessageRow, type ToolCallInfo } from './session-view.js';
import { type ExecutionSupervisionView, type GoalStartResult, type GoalWaitResult } from './goal.js';
import { type BlockedInfo } from './goal-graph.js';
import { type GoalHistoryEvent, type GoalSupervisionView } from './goal-control.js';
import { type ExecutionMode, type GoalConstraints } from './goal-constraints.js';
import { type UserApprovalPolicy } from './approval-policy.js';
import { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { ExecutionIdempotencyManager } from './execution-idempotency.js';
import { type ResultSchema, type CredentialStatus } from './result-schema.js';
export { normalizePath } from './paths.js';
/** Typed bridge error with a stable machine-readable code. */
export declare class BridgeError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>);
}
/** One parked approval waiting on a ChatGPT decision. */
export interface PendingApproval {
    id: string;
    sessionId: string;
    toolName: string;
    callId?: string;
    reason?: string;
    command?: string;
    capability?: string;
    level?: string;
    resolve: (outcome: ApprovalOutcome) => void;
    /** Set when the Web api-proxy parked this ask; settle via respond(). */
    muxRpcId?: string;
}
/** Who blocked or decided an approval, for deadlock diagnostics. */
export type ApprovalLayer = 'user' | 'bridge_policy' | 'dsh_policy' | 'platform';
export interface ApprovalRequestLike {
    agent: {
        id: string;
        session?: {
            snapshotEvents?: () => readonly SessionEvent[];
            header?: {
                cwd?: string;
            };
        };
    };
    toolName: string;
    callId?: string;
    reason?: string;
    signal?: AbortSignal;
}
/** One parked user question waiting on a ChatGPT answer. */
export interface PendingQuestion {
    id: string;
    callId?: string;
    sessionId?: string;
    questions: AskUserQuestionItem[];
    resolve: (answer: AskUserQuestionAnswer) => void;
    muxRpcId?: string;
}
/** Wire-safe approval summary shown in dsh_get_session / dsh_get_task_status. */
export interface ApprovalSummary {
    approval_id: string;
    session_id: string;
    tool_name: string;
    call_id?: string;
    reason?: string;
}
/** Wire-safe question summary shown in dsh_get_session / dsh_get_task_status. */
export interface QuestionSummary {
    question_id: string;
    session_id?: string;
    questions: AskUserQuestionItem[];
}
export interface WaitingState {
    approvals: ApprovalSummary[];
    questions: QuestionSummary[];
}
export interface HealthReport {
    status: string;
    bridge: {
        name: string;
        version: string;
    };
    dsh: {
        version: string;
    };
    runtime: {
        pid: number;
        uptimeMs: number;
    };
    sessions: {
        live: number;
        persisted: number;
        active: number;
    };
    capabilities: {
        transports: string[];
        authMode: 'token' | 'none';
        workspaceRegistry: boolean;
        sessionPersistence: boolean;
        agentPresets: boolean;
        userQuestions: boolean;
        approvals: boolean;
        workspaces: number;
        webSurface: boolean;
        goalSupervision: boolean;
    };
}
export interface WorkspaceView {
    id: string;
    title: string;
    path: string;
    createdAt: string;
    updatedAt: string;
    sessionCount: number;
}
export interface SessionView {
    session_id: string;
    title?: string;
    workspace?: string;
    status: BridgeStatus;
    created_at: string;
    updated_at?: string;
    agent?: {
        status: 'idle' | 'running';
        inbox: {
            nextTurn: number;
            nextStep: number;
        };
    };
    pending: {
        nextTurn: number;
        nextStep: number;
    };
    waiting: WaitingState;
    messages: MessageRow[];
    last_turn?: {
        turn: number;
        reason?: string;
    };
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
}
export interface SessionSummary {
    session_id: string;
    title?: string;
    workspace?: string;
    status?: BridgeStatus;
    created_at: string;
    updated_at?: string;
}
export interface ResultView {
    session_id: string;
    status: BridgeStatus;
    turn: number;
    summary: string;
    assistant_text: string;
    changed_files: string[];
    tool_calls: ToolCallInfo[];
    error?: {
        code: string;
        message: string;
    };
    result_schema?: ResultSchema;
}
/** DSH version string, resolved lazily from the installed package. */
export declare function dshVersion(): string;
/** The bridge service. One instance per plugin activation. */
export declare class Bridge {
    private readonly ctx;
    private readonly cfg;
    private readonly log;
    /** Sessions created through this bridge (approval answering scope). */
    private readonly managed;
    private readonly approvals;
    private readonly questions;
    private questionSeq;
    private approvalsEnabled;
    private questionsEnabled;
    private started;
    private readonly goalRequests;
    private readonly goalStore;
    private readonly pollCursors;
    private apiProxy;
    private muxAbort;
    private webOwnsApprovals;
    readonly workspaceGuard: WorkspaceConcurrencyGuard;
    readonly idempotencyManager: ExecutionIdempotencyManager;
    private readonly workspaceBaselines;
    private readonly recordedMutationCalls;
    private readonly recordedExecutionEvidenceCalls;
    private readonly observedSuccessfulMutationCalls;
    private readonly pendingBaselineRefresh;
    private readonly pendingExecutionFingerprints;
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
    /** Agent-scoped model selection with log-derived fallback for resumes. */
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
    startGoal(input: {
        workspace: string;
        goal: string;
        plan?: string;
        session_id?: string;
        request_id?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        expected_revision?: number;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    updateGoal(input: {
        session_id: string;
        action?: 'revise' | 'defer' | 'resume';
        goal?: string;
        plan?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        expected_revision?: number;
        defer_steps?: string[];
        resume_steps?: string[];
        revision_reason?: string;
        request_id?: string;
        workspace?: string;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    waitGoal(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult>;
    stopGoal(sessionId: string): Promise<{
        session_id: string;
        stopped: true;
        already_stopped: boolean;
        status: BridgeStatus;
        cleanup_warning?: string;
    }>;
    private failClosedWaiting;
    private applyStartOrRevise;
    private controlMessage;
    private mapGoalStart;
    private noteGoalEvent;
    /**
     * Decide a DSH approval/request for a managed session.
     * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
     * deny/reject always remain reachable even if approve is blocked.
     */
    decideApproval(request: ApprovalRequestLike, next?: () => Promise<ApprovalOutcome> | ApprovalOutcome): Promise<ApprovalOutcome>;
    private rejectConstraint;
    private observeGoal;
    private goalFields;
    private cleanupGoalTemps;
    private goalSnapshot;
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
    private isLockHolderActive;
    private workspaceLockedError;
    private assertMutableWorkspaceAvailable;
    private takeWorkspaceLock;
    private releaseWorkspaceIfTerminal;
    private skipIdempotentStep;
    private recordObservedExecutions;
    private recordObservedExecutionFacts;
    private executionFingerprintExtra;
    private refreshWorkspaceBaselineIfNeeded;
    private noteMutation;
    private rememberMutationCall;
    private rememberExecutionEvidenceCall;
    private rememberObservedSuccessfulMutationCall;
    private rememberPendingExecutionFingerprint;
    listManaged(): string[];
}
