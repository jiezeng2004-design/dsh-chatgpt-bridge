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
import { assistantTextForTurn, changedFilesForTurn, lastEventTime, lastTurnSpan } from './session-view.js';
import type { BridgeStatus } from './status.js';
import {
  DEFAULT_WAIT_SECONDS,
  executionView,
  mapStartGoal,
  mapWaitGoal,
  type GoalStartResult,
  type GoalWaitResult,
} from './goal.js';
import { foldGoalFacts, successfulKinds } from './goal-facts.js';
import { reconcileTodos } from './goal-reconcile.js';
import { buildGoalGraph, deferredKindsOf, describeBlocked, inferBlockedKind } from './goal-graph.js';
import { PollCursorMap, computeProgressDelta, nextPollCursor } from './goal-delta.js';
import { cleanupTempResources, discoverTempResources } from './temp-resources.js';
import {
  appendGoalEvent,
  applyNativeGetGoalResult,
  sliceHistory,
  supervisionGoal,
  type GoalControlStore,
  type GoalHistoryEvent,
} from './goal-control.js';
import { findPostHocViolation } from './goal-constraints.js';

/** Append a goal-history event to the session's goal record, when one exists. */
export function recordGoalEvent(
  goalStore: GoalControlStore,
  now: () => number,
  sessionId: string,
  type: GoalHistoryEvent['type'],
  extra?: { step_id?: string; metadata?: Record<string, unknown> },
): void {
  const record = goalStore.get(sessionId);
  if (record === undefined) return;
  goalStore.put(appendGoalEvent(record, type, { ...extra, now: now() }));
}

export interface GoalObserverDeps {
  goalStore: GoalControlStore;
  workspace: WorkspaceTracker;
  now: () => number;
  waitingFor: (sessionId: string, events?: readonly SessionEvent[]) => WaitingState;
  statusOf: (sessionId: string, view: LoadedView) => Promise<BridgeStatus>;
}

export class GoalObserver {
  private readonly goalStore: GoalControlStore;
  private readonly workspace: WorkspaceTracker;
  private readonly now: () => number;
  private readonly waitingFor: GoalObserverDeps['waitingFor'];
  private readonly statusOf: GoalObserverDeps['statusOf'];
  private readonly pollCursors = new PollCursorMap();

  constructor(deps: GoalObserverDeps) {
    this.goalStore = deps.goalStore;
    this.workspace = deps.workspace;
    this.now = deps.now;
    this.waitingFor = deps.waitingFor;
    this.statusOf = deps.statusOf;
  }

  async mapGoalStart(sessionId: string, view: LoadedView): Promise<GoalStartResult> {
    const status = await this.statusOf(sessionId, view);
    this.workspace.releaseWorkspaceIfTerminal(sessionId, status);
    const observed = this.observeGoal(sessionId, view, status);
    const record = applyNativeGetGoalResult(this.goalStore.get(sessionId), undefined);
    const currentStep = observed.blocked?.step
      ?? observed.graph.steps.find((step) => step.status === 'in_progress' || step.status === 'ready')?.content
      ?? observed.graph.remaining_runnable_steps[0];
    return mapStartGoal(sessionId, status, DEFAULT_WAIT_SECONDS, {
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(observed.graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    });
  }

  observeGoal(sessionId: string, view: LoadedView, status: BridgeStatus) {
    const facts = foldGoalFacts(view.events);
    this.workspace.recordObservedExecutions(sessionId, view, facts);
    let record = this.goalStore.get(sessionId);
    const succeeded = [...successfulKinds(facts)];
    if (record !== undefined && succeeded.some((kind) => !record!.completed_action_kinds.includes(kind))) {
      record = {
        ...record,
        completed_action_kinds: [...new Set([...record.completed_action_kinds, ...succeeded])],
      };
      this.goalStore.put(record);
    }
    const isHeld = status === 'waiting_for_approval' || status === 'waiting_for_user' || status === 'blocked';
    const waitingKinds = isHeld
      ? (() => {
          const kind = inferBlockedKind(facts, status);
          return kind === undefined ? [] : [kind];
        })()
      : [];
    const todos = reconcileTodos({
      ...(facts.todos === undefined ? {} : { todos: facts.todos }),
      facts,
      waitingKinds,
      holdInProgress: isHeld,
    });
    const blockedKind = inferBlockedKind(facts, status);
    const deferredKinds = deferredKindsOf(record?.deferred_step_ids);
    const graph = buildGoalGraph({
      ...(todos === undefined ? {} : { todos }),
      ...(record?.plan === undefined ? {} : { plan: record.plan }),
      facts,
      deferredKinds,
      ...(record === undefined ? {} : { deferredStepIds: record.deferred_step_ids }),
      ...(blockedKind === undefined ? {} : { blockedKind }),
      ...(status === 'waiting_for_user' || status === 'waiting_for_approval' ? { waitingStatus: status } : {}),
    });
    const waiting = this.waitingFor(sessionId, view.events);
    let blocked = describeBlocked({
      status,
      facts,
      graph,
      approval: waiting.approvals[0],
      question: waiting.questions[0],
    });
    if (record !== undefined) {
      const violation = findPostHocViolation(facts, record.constraints);
      if (violation !== undefined) {
        blocked = {
          step: violation.step,
          reason: 'constraint_rejected',
          resume_condition: `Constraint ${violation.reason} rejected this action. Revise constraints or the goal, then resume.`,
          scope: graph.remaining_runnable_steps.length > 0 ? 'step' : 'goal',
          independent_steps_available: graph.remaining_runnable_steps.length > 0,
        };
      }
    }
    return { facts, todos, graph, blocked, waiting, record };
  }

  goalFields(sessionId: string, view: LoadedView, status: BridgeStatus): GoalFields {
    const { todos, graph, blocked, record: observedRecord } = this.observeGoal(sessionId, view, status);
    const record = applyNativeGetGoalResult(observedRecord, undefined);
    const currentStep = blocked?.step
      ?? graph.steps.find((step) => step.status === 'in_progress' || step.status === 'ready')?.content
      ?? graph.remaining_runnable_steps[0];
    return {
      ...(todos === undefined ? {} : { todos }),
      ...(blocked === undefined ? {} : { blocked }),
      ...(graph.deferred_steps.length === 0 ? {} : { deferred_steps: graph.deferred_steps }),
      ...(graph.blocked_steps.length === 0 ? {} : { blocked_steps: graph.blocked_steps }),
      ...(graph.remaining_runnable_steps.length === 0 ? {} : { remaining_runnable_steps: graph.remaining_runnable_steps }),
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    };
  }

  cleanupGoalTemps(sessionId: string, view: LoadedView): string | undefined {
    const workspace = view.header.cwd;
    if (typeof workspace !== 'string' || workspace === '') return undefined;
    const facts = foldGoalFacts(view.events);
    const record = this.goalStore.get(sessionId);
    const resources = discoverTempResources({
      facts,
      sessionId,
      goalId: record?.goal_id ?? sessionId,
      workspacePath: workspace,
    });
    if (resources.length === 0) return undefined;
    const cleaned = cleanupTempResources(resources, workspace);
    if (cleaned.warnings.length === 0) return undefined;
    return cleaned.warnings.join('; ');
  }

  async goalSnapshot(
    sessionId: string,
    view: LoadedView,
    status: BridgeStatus,
    waitedMs: number,
    waitSeconds: number,
  ): Promise<GoalWaitResult> {
    const { facts, todos, graph, blocked, waiting, record: observedRecord } = this.observeGoal(sessionId, view, status);
    const record = applyNativeGetGoalResult(observedRecord, undefined);
    const span = lastTurnSpan(view.events);
    const changedFiles = span === undefined ? [] : changedFilesForTurn(view.events, span.turn);
    const errorSummary = span?.reason !== undefined && span.reason.kind === 'error'
      ? `${span.reason.error.code}: ${span.reason.error.message}`
      : undefined;
    const currentStep = blocked?.step
      ?? graph.steps.find((step) => step.status === 'in_progress')?.content
      ?? graph.remaining_runnable_steps[0];
    const approvalIds = waiting.approvals.map((item) => item.approval_id);
    const questionIds = waiting.questions.map((item) => item.question_id);
    const deltaInput = {
      events: view.events,
      facts,
      ...(todos === undefined ? {} : { todos }),
      status,
      changedFiles,
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
      approvalIds,
      questionIds,
      previous: this.pollCursors.get(sessionId),
      ...(currentStep === undefined ? {} : { currentStep }),
    };
    const progressDelta = computeProgressDelta(deltaInput);
    this.pollCursors.set(sessionId, nextPollCursor(deltaInput));
    const mapped = mapWaitGoal({
      sessionId,
      status,
      waitedMs,
      waitSeconds,
      ...(todos === undefined ? {} : { todos }),
      lastActivity: lastEventTime(view.events),
      ...(span === undefined ? {} : { lastTurn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      changedFiles,
      assistantSummary: span === undefined ? '' : assistantTextForTurn(view.events, span.turn),
      ...(errorSummary === undefined ? {} : { errorSummary }),
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
      approval: waiting.approvals[0],
      question: waiting.questions[0],
      progressDelta,
      ...(blocked === undefined ? {} : { blocked }),
      deferredSteps: graph.deferred_steps,
      blockedSteps: graph.blocked_steps,
      remainingRunnableSteps: graph.remaining_runnable_steps,
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    });
    if (mapped.terminal && record !== undefined && (status === 'completed' || status === 'cancelled' || status === 'failed')) {
      const already = record.history.some((event) => event.type === 'goal_completed' || event.type === 'goal_cancelled');
      if (!already) {
        this.goalStore.put(appendGoalEvent(record, status === 'cancelled' ? 'goal_cancelled' : 'goal_completed', { now: this.now() }));
      }
    }
    this.workspace.releaseWorkspaceIfTerminal(sessionId, status);
    if (!mapped.terminal) return mapped;
    const warning = this.cleanupGoalTemps(sessionId, view);
    return warning === undefined ? mapped : { ...mapped, cleanup_warning: warning };
  }
}
