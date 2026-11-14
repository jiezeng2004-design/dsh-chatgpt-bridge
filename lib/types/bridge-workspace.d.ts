/**
 * Workspace tracking for supervised goals: per-session workspace baselines,
 * mutable-workspace lock arbitration, mutation recording against the
 * concurrency guard, and execution-evidence / idempotency bookkeeping
 * (fingerprints, observed successful calls, step skipping). It owns all of
 * that state; the guard, idempotency manager and goal store are shared with
 * the Bridge facade, which keeps exposing them.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type LoadedView } from './bridge-types.js';
import type { BridgeLogger } from './log.js';
import { foldGoalFacts } from './goal-facts.js';
import type { GoalControlStore, GoalHistoryEvent } from './goal-control.js';
import type { WorkspaceBaseline, WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { type ExecutionIdempotencyManager } from './execution-idempotency.js';
import type { BridgeStatus } from './status.js';
export interface WorkspaceTrackerDeps {
    ctx: Context;
    log: BridgeLogger;
    workspaceGuard: WorkspaceConcurrencyGuard;
    idempotencyManager: ExecutionIdempotencyManager;
    goalStore: GoalControlStore;
    noteGoalEvent: (sessionId: string, type: GoalHistoryEvent['type'], extra?: {
        step_id?: string;
        metadata?: Record<string, unknown>;
    }) => void;
}
export declare class WorkspaceTracker {
    private readonly ctx;
    private readonly log;
    private readonly workspaceGuard;
    private readonly idempotencyManager;
    private readonly goalStore;
    private readonly noteGoalEvent;
    private readonly workspaceBaselines;
    private readonly recordedMutationCalls;
    private readonly recordedExecutionEvidenceCalls;
    private readonly observedSuccessfulMutationCalls;
    private readonly pendingBaselineRefresh;
    private readonly pendingExecutionFingerprints;
    constructor(deps: WorkspaceTrackerDeps);
    /** The recorded workspace baseline for a session, if any. */
    baselineOf(sessionId: string): WorkspaceBaseline | undefined;
    private isLockHolderActive;
    private workspaceLockedError;
    assertMutableWorkspaceAvailable(workspacePath: string, sessionId: string | undefined, override: boolean, isReadOnly: boolean): void;
    takeWorkspaceLock(workspacePath: string, sessionId: string, override: boolean, isReadOnly: boolean): Promise<void>;
    releaseWorkspaceIfTerminal(sessionId: string, status: BridgeStatus): void;
    skipIdempotentStep(sessionId: string, toolName: string, command: string | undefined, workspacePath: string, snapshot?: WorkspaceBaseline, callId?: string): {
        code: string;
        evidenceId: string;
    } | undefined;
    recordObservedExecutions(sessionId: string, view: LoadedView, facts: ReturnType<typeof foldGoalFacts>): void;
    recordObservedExecutionFacts(sessionId: string, workspacePath: string, facts: ReturnType<typeof foldGoalFacts>): void;
    private executionFingerprintExtra;
    refreshWorkspaceBaselineIfNeeded(sessionId: string, workspacePath: string): Promise<void>;
    noteMutation(workspacePath: string, sessionId: string, toolName: string, command: string | undefined, callId?: string): void;
    private rememberMutationCall;
    private rememberExecutionEvidenceCall;
    private rememberObservedSuccessfulMutationCall;
    private rememberPendingExecutionFingerprint;
}
