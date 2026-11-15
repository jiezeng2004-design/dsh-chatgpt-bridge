/**
 * Goal observation and projections: folds session events into goal facts,
 * reconciles them with the stored goal record (completed kinds, blockers,
 * deferred steps), and builds the supervision views returned by
 * dsh_get_session / dsh_get_task_status / dsh_start_goal / dsh_wait_goal
 * (goal fields, execution graph, progress deltas, temp-resource cleanup).
 * Also owns the per-session poll cursors and the goal-history event helper.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { GoalFields, LoadedView, WaitingState } from './bridge-types.js';
import type { WorkspaceTracker } from './bridge-workspace.js';
import type { BridgeStatus } from './status.js';
import { type GoalStartResult, type GoalWaitResult } from './goal.js';
import { type GoalControlStore, type GoalHistoryEvent } from './goal-control.js';
/** Append a goal-history event to the session's goal record, when one exists. */
export declare function recordGoalEvent(goalStore: GoalControlStore, now: () => number, sessionId: string, type: GoalHistoryEvent['type'], extra?: {
    step_id?: string;
    metadata?: Record<string, unknown>;
}): void;
export interface GoalObserverDeps {
    goalStore: GoalControlStore;
    workspace: WorkspaceTracker;
    now: () => number;
    waitingFor: (sessionId: string, events?: readonly SessionEvent[]) => WaitingState;
    statusOf: (sessionId: string, view: LoadedView) => Promise<BridgeStatus>;
}
export declare class GoalObserver {
    private readonly goalStore;
    private readonly workspace;
    private readonly now;
    private readonly waitingFor;
    private readonly statusOf;
    private readonly pollCursors;
    constructor(deps: GoalObserverDeps);
    mapGoalStart(sessionId: string, view: LoadedView): Promise<GoalStartResult>;
    observeGoal(sessionId: string, view: LoadedView, status: BridgeStatus): {
        facts: import("./goal-facts.js").GoalFacts;
        todos: import("./goal-reconcile.js").ReconcileTodo[] | undefined;
        graph: import("./goal-graph.js").GoalGraph;
        blocked: import("./goal-graph.js").BlockedInfo | undefined;
        waiting: WaitingState;
        record: import("./goal-control.js").GoalRecord | undefined;
    };
    goalFields(sessionId: string, view: LoadedView, status: BridgeStatus): GoalFields;
    cleanupGoalTemps(sessionId: string, view: LoadedView): string | undefined;
    goalSnapshot(sessionId: string, view: LoadedView, status: BridgeStatus, waitedMs: number, waitSeconds: number): Promise<GoalWaitResult>;
}
