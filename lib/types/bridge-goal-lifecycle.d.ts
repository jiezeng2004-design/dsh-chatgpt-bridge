/**
 * Goal supervision lifecycle: start / update (revise, defer, resume) / retry /
 * rerun / pause / wait / stop. Handles request-id idempotency, revision and
 * workspace-lock arbitration, goal-record persistence, control-message
 * delivery and the bounded wait loops. Session loading and creation stay on
 * the Bridge facade and are reached through `GoalLifecycleDeps`, so test hooks
 * (`now`, `sleep`) and overrides on the Bridge are honoured live.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import { type LoadedView, type SessionView } from './bridge-types.js';
import type { ApprovalBroker } from './bridge-approvals.js';
import type { GoalObserver } from './bridge-goal-view.js';
import type { WorkspaceTracker } from './bridge-workspace.js';
import type { BridgeStatus } from './status.js';
import { type GoalStartResult, type GoalWaitResult } from './goal.js';
import { type GoalControlStore } from './goal-control.js';
import { type ExecutionMode, type GoalConstraints } from './goal-constraints.js';
import { type ExecutionIdempotencyManager } from './execution-idempotency.js';
import type { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import type { GoalHistoryEvent } from './goal-control.js';
export interface StartGoalInput {
    workspace: string;
    goal: string;
    plan?: string;
    session_id?: string;
    request_id?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
    expected_revision?: number;
    workspace_lock_override?: boolean;
}
export interface UpdateGoalInput {
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
}
export interface GoalLifecycleDeps {
    ctx: Context;
    goalStore: GoalControlStore;
    idempotencyManager: ExecutionIdempotencyManager;
    workspaceGuard: WorkspaceConcurrencyGuard;
    workspace: WorkspaceTracker;
    broker: ApprovalBroker;
    observer: GoalObserver;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    noteGoalEvent: (sessionId: string, type: GoalHistoryEvent['type'], extra?: {
        step_id?: string;
        metadata?: Record<string, unknown>;
    }) => void;
    adopt: (sessionId: string) => void;
    loadView: (sessionId: string) => Promise<LoadedView>;
    statusOf: (sessionId: string, view: LoadedView) => Promise<BridgeStatus>;
    ensureAgent: (sessionId: string) => Promise<Agent>;
    resolveWorkspace: (input: string) => Promise<Workspace>;
    createSession: (workspaceInput: string, title?: string, initialMessage?: string) => Promise<SessionView>;
    sendMessage: (sessionId: string, message: string) => Promise<{
        session_id: string;
        accepted: boolean;
    }>;
}
export declare class GoalLifecycle {
    private readonly ctx;
    private readonly goalStore;
    private readonly idempotencyManager;
    private readonly workspaceGuard;
    private readonly workspace;
    private readonly broker;
    private readonly observer;
    private readonly now;
    private readonly sleep;
    private readonly noteGoalEvent;
    private readonly adopt;
    private readonly loadView;
    private readonly statusOf;
    private readonly ensureAgent;
    private readonly resolveWorkspace;
    private readonly createSession;
    private readonly sendMessage;
    private readonly goalRequests;
    constructor(deps: GoalLifecycleDeps);
    pauseGoal(sessionId: string): Promise<{
        session_id: string;
        status: BridgeStatus;
        paused: boolean;
        checkpoint_revision: number;
    }>;
    retryStep(sessionId: string, stepId: string, requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    rerunStep(sessionId: string, stepId: string, requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    waitUntilActionRequired(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult>;
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
    private applyStartOrRevise;
    private controlMessage;
}
