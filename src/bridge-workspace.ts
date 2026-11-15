/**
 * Workspace tracking for supervised goals: per-session workspace baselines,
 * mutable-workspace lock arbitration, mutation recording against the
 * concurrency guard, and execution-evidence / idempotency bookkeeping
 * (fingerprints, observed successful calls, step skipping). It owns all of
 * that state; the guard, idempotency manager and goal store are shared with
 * the Bridge facade, which keeps exposing them.
 */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { BridgeError, type LoadedView } from './bridge-types.js';
import { isMutatingTool, rememberCappedSet } from './bridge-helpers.js';
import type { BridgeLogger } from './log.js';
import { isTerminalStatus } from './goal.js';
import { foldGoalFacts } from './goal-facts.js';
import type { GoalControlStore, GoalHistoryEvent } from './goal-control.js';
import type { WorkspaceBaseline, WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { idempotencyKindFor, isVerifiedKind, type ExecutionIdempotencyManager } from './execution-idempotency.js';
import type { BridgeStatus } from './status.js';

export interface WorkspaceTrackerDeps {
  ctx: Context;
  log: BridgeLogger;
  workspaceGuard: WorkspaceConcurrencyGuard;
  idempotencyManager: ExecutionIdempotencyManager;
  goalStore: GoalControlStore;
  noteGoalEvent: (
    sessionId: string,
    type: GoalHistoryEvent['type'],
    extra?: { step_id?: string; metadata?: Record<string, unknown> },
  ) => void;
}

export class WorkspaceTracker {
  private readonly ctx: Context;
  private readonly log: BridgeLogger;
  private readonly workspaceGuard: WorkspaceConcurrencyGuard;
  private readonly idempotencyManager: ExecutionIdempotencyManager;
  private readonly goalStore: GoalControlStore;
  private readonly noteGoalEvent: WorkspaceTrackerDeps['noteGoalEvent'];
  private readonly workspaceBaselines = new Map<string, WorkspaceBaseline>();
  private readonly recordedMutationCalls = new Set<string>();
  private readonly recordedExecutionEvidenceCalls = new Set<string>();
  private readonly observedSuccessfulMutationCalls = new Set<string>();
  private readonly pendingBaselineRefresh = new Set<string>();
  private readonly pendingExecutionFingerprints = new Map<string, { kind: string; fingerprint: string }>();

  constructor(deps: WorkspaceTrackerDeps) {
    this.ctx = deps.ctx;
    this.log = deps.log;
    this.workspaceGuard = deps.workspaceGuard;
    this.idempotencyManager = deps.idempotencyManager;
    this.goalStore = deps.goalStore;
    this.noteGoalEvent = deps.noteGoalEvent;
  }

  /** The recorded workspace baseline for a session, if any. */
  baselineOf(sessionId: string): WorkspaceBaseline | undefined {
    return this.workspaceBaselines.get(sessionId);
  }

  private isLockHolderActive(sessionId: string): boolean {
    const holderAgent = this.ctx.agents.get(SessionId(sessionId));
    if (holderAgent === undefined) return false;
    if (holderAgent.status === 'running') return true;
    return holderAgent.inbox.nextTurn.length > 0 || holderAgent.inbox.nextStep.length > 0;
  }

  private workspaceLockedError(holder: { sessionId: string; goalId: string }): BridgeError {
    return new BridgeError(
      'WORKSPACE_LOCKED',
      `workspace is locked by session ${holder.sessionId} (goal ${holder.goalId}); waiting_for_workspace_lock. Pass workspace_lock_override=true to take over.`,
      {
        status: 'waiting_for_workspace_lock',
        holder_session_id: holder.sessionId,
        holder_goal_id: holder.goalId,
      },
    );
  }

  assertMutableWorkspaceAvailable(
    workspacePath: string,
    sessionId: string | undefined,
    override: boolean,
    isReadOnly: boolean,
  ): void {
    if (isReadOnly || override) return;
    const existing = this.workspaceGuard.getLock(workspacePath);
    if (existing === undefined) return;
    if (sessionId !== undefined && existing.sessionId === sessionId) return;
    if (this.isLockHolderActive(existing.sessionId)) {
      throw this.workspaceLockedError(existing);
    }
  }

  async takeWorkspaceLock(
    workspacePath: string,
    sessionId: string,
    override: boolean,
    isReadOnly: boolean,
  ): Promise<void> {
    if (isReadOnly) return;
    const existing = this.workspaceGuard.getLock(workspacePath);
    const holderActive = existing !== undefined && existing.sessionId !== sessionId
      ? this.isLockHolderActive(existing.sessionId)
      : false;
    const lockRes = this.workspaceGuard.acquireMutableLock(
      workspacePath,
      sessionId,
      `goal-${sessionId}`,
      holderActive,
      override,
    );
    if (!lockRes.success && lockRes.holder !== undefined) {
      throw this.workspaceLockedError(lockRes.holder);
    }
    if (lockRes.warning) this.log.warn(lockRes.warning);
    if (!this.workspaceBaselines.has(sessionId)) {
      const baseline = await this.workspaceGuard.captureBaseline(workspacePath);
      this.workspaceBaselines.set(sessionId, baseline);
    }
  }

  releaseWorkspaceIfTerminal(sessionId: string, status: BridgeStatus): void {
    if (isTerminalStatus(status)) this.workspaceGuard.releaseLock(sessionId);
  }

  skipIdempotentStep(
    sessionId: string,
    toolName: string,
    command: string | undefined,
    workspacePath: string,
    snapshot?: WorkspaceBaseline,
    callId?: string,
  ): { code: string; evidenceId: string } | undefined {
    const kind = idempotencyKindFor(toolName, command);
    if (kind === undefined) return undefined;
    const fingerprint = this.idempotencyManager.computeFingerprint({
      kind,
      command,
      workspacePath,
      headSha: snapshot?.headSha,
      extra: this.executionFingerprintExtra(snapshot),
    });
    const hit = this.idempotencyManager.check(fingerprint, { sessionId, workspacePath });
    if (hit === null) {
      if (callId !== undefined) {
        this.rememberPendingExecutionFingerprint(`${sessionId}:${callId}`, { kind, fingerprint });
      }
      return undefined;
    }
    this.noteGoalEvent(sessionId, 'step_skipped', {
      step_id: kind,
      metadata: {
        code: hit.code,
        evidence_id: hit.evidenceId,
        command,
        message: hit.message,
      },
    });
    this.log.info(`skipping ${kind} on ${sessionId}: ${hit.code} (${hit.evidenceId})`);
    return { code: hit.code, evidenceId: hit.evidenceId };
  }

  recordObservedExecutions(
    sessionId: string,
    view: LoadedView,
    facts: ReturnType<typeof foldGoalFacts>,
  ): void {
    const workspacePath = view.header?.cwd ?? this.workspaceBaselines.get(sessionId)?.workspacePath;
    if (workspacePath === undefined || workspacePath === '') return;
    this.recordObservedExecutionFacts(sessionId, workspacePath, facts);
  }

  recordObservedExecutionFacts(
    sessionId: string,
    workspacePath: string,
    facts: ReturnType<typeof foldGoalFacts>,
  ): void {
    const baseline = this.workspaceBaselines.get(sessionId);
    const goalId = this.goalStore.get(sessionId)?.goal_id ?? `goal-${sessionId}`;
    for (const tool of facts.tools) {
      if (!tool.ok) continue;
      const key = `${sessionId}:${tool.callId}`;
      if (isMutatingTool(tool.name, tool.command) && !this.observedSuccessfulMutationCalls.has(key)) {
        this.rememberObservedSuccessfulMutationCall(key);
        this.pendingBaselineRefresh.add(sessionId);
        if (!this.recordedMutationCalls.has(key)) {
          this.rememberMutationCall(key);
          this.workspaceGuard.recordMutation(workspacePath, {
            sessionId,
            goalId,
            stepId: tool.callId,
            type: idempotencyKindFor(tool.name, tool.command) ?? tool.name,
            details: tool.command,
          });
        }
      }
      const kind = idempotencyKindFor(tool.name, tool.command);
      if (kind === undefined) continue;
      if (this.recordedExecutionEvidenceCalls.has(key)) continue;
      this.rememberExecutionEvidenceCall(key);
      const pending = this.pendingExecutionFingerprints.get(key);
      this.pendingExecutionFingerprints.delete(key);
      const fingerprint = pending?.kind === kind
        ? pending.fingerprint
        : this.idempotencyManager.computeFingerprint({
            kind,
            command: tool.command,
            workspacePath,
            headSha: baseline?.headSha,
            extra: this.executionFingerprintExtra(baseline),
          });
      if (this.idempotencyManager.check(fingerprint, { sessionId, workspacePath }) !== null) continue;
      this.idempotencyManager.recordSuccess(fingerprint, {
        kind,
        status: isVerifiedKind(kind) ? 'passed' : 'applied',
        summary: tool.resultText,
        sessionId,
        workspacePath,
      });
    }
  }

  private executionFingerprintExtra(snapshot?: WorkspaceBaseline): Record<string, unknown> {
    return {
      workspace_fingerprint: snapshot?.workspaceFingerprint ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    };
  }

  async refreshWorkspaceBaselineIfNeeded(sessionId: string, workspacePath: string): Promise<void> {
    if (!this.pendingBaselineRefresh.delete(sessionId)) return;
    this.workspaceBaselines.set(sessionId, await this.workspaceGuard.captureBaseline(workspacePath));
  }

  noteMutation(
    workspacePath: string,
    sessionId: string,
    toolName: string,
    command: string | undefined,
    callId?: string,
  ): void {
    const key = `${sessionId}:${callId ?? toolName}:${command ?? ''}`;
    if (this.recordedMutationCalls.has(key)) return;
    this.rememberMutationCall(key);
    this.workspaceGuard.recordMutation(workspacePath, {
      sessionId,
      goalId: this.goalStore.get(sessionId)?.goal_id ?? `goal-${sessionId}`,
      stepId: callId,
      type: idempotencyKindFor(toolName, command) ?? toolName,
      details: command,
    });
  }

  private rememberMutationCall(key: string): void {
    this.recordedMutationCalls.add(key);
    while (this.recordedMutationCalls.size > 2048) {
      const oldest = this.recordedMutationCalls.values().next().value;
      if (oldest === undefined) break;
      this.recordedMutationCalls.delete(oldest);
    }
  }

  private rememberExecutionEvidenceCall(key: string): void {
    rememberCappedSet(this.recordedExecutionEvidenceCalls, key);
  }

  private rememberObservedSuccessfulMutationCall(key: string): void {
    rememberCappedSet(this.observedSuccessfulMutationCalls, key);
  }

  private rememberPendingExecutionFingerprint(
    key: string,
    value: { kind: string; fingerprint: string },
  ): void {
    if (this.pendingExecutionFingerprints.has(key)) this.pendingExecutionFingerprints.delete(key);
    this.pendingExecutionFingerprints.set(key, value);
    while (this.pendingExecutionFingerprints.size > 2048) {
      const oldest = this.pendingExecutionFingerprints.keys().next().value;
      if (oldest === undefined) break;
      this.pendingExecutionFingerprints.delete(oldest);
    }
  }
}
