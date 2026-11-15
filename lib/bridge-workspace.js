import { SessionId } from '@deepseek-ai/dsh-session';
import { BridgeError } from './bridge-types.js';
import { isMutatingTool, rememberCappedSet } from './bridge-helpers.js';
import { isTerminalStatus } from './goal.js';
import { foldGoalFacts } from './goal-facts.js';
import { idempotencyKindFor, isVerifiedKind } from './execution-idempotency.js';
export class WorkspaceTracker {
    ctx;
    log;
    workspaceGuard;
    idempotencyManager;
    goalStore;
    noteGoalEvent;
    workspaceBaselines = new Map();
    recordedMutationCalls = new Set();
    recordedExecutionEvidenceCalls = new Set();
    observedSuccessfulMutationCalls = new Set();
    pendingBaselineRefresh = new Set();
    pendingExecutionFingerprints = new Map();
    constructor(deps) {
        this.ctx = deps.ctx;
        this.log = deps.log;
        this.workspaceGuard = deps.workspaceGuard;
        this.idempotencyManager = deps.idempotencyManager;
        this.goalStore = deps.goalStore;
        this.noteGoalEvent = deps.noteGoalEvent;
    }
    /** The recorded workspace baseline for a session, if any. */
    baselineOf(sessionId) {
        return this.workspaceBaselines.get(sessionId);
    }
    isLockHolderActive(sessionId) {
        const holderAgent = this.ctx.agents.get(SessionId(sessionId));
        if (holderAgent === undefined)
            return false;
        if (holderAgent.status === 'running')
            return true;
        return holderAgent.inbox.nextTurn.length > 0 || holderAgent.inbox.nextStep.length > 0;
    }
    workspaceLockedError(holder) {
        return new BridgeError('WORKSPACE_LOCKED', `workspace is locked by session ${holder.sessionId} (goal ${holder.goalId}); waiting_for_workspace_lock. Pass workspace_lock_override=true to take over.`, {
            status: 'waiting_for_workspace_lock',
            holder_session_id: holder.sessionId,
            holder_goal_id: holder.goalId,
        });
    }
    assertMutableWorkspaceAvailable(workspacePath, sessionId, override, isReadOnly) {
        if (isReadOnly || override)
            return;
        const existing = this.workspaceGuard.getLock(workspacePath);
        if (existing === undefined)
            return;
        if (sessionId !== undefined && existing.sessionId === sessionId)
            return;
        if (this.isLockHolderActive(existing.sessionId)) {
            throw this.workspaceLockedError(existing);
        }
    }
    async takeWorkspaceLock(workspacePath, sessionId, override, isReadOnly) {
        if (isReadOnly)
            return;
        const existing = this.workspaceGuard.getLock(workspacePath);
        const holderActive = existing !== undefined && existing.sessionId !== sessionId
            ? this.isLockHolderActive(existing.sessionId)
            : false;
        const lockRes = this.workspaceGuard.acquireMutableLock(workspacePath, sessionId, `goal-${sessionId}`, holderActive, override);
        if (!lockRes.success && lockRes.holder !== undefined) {
            throw this.workspaceLockedError(lockRes.holder);
        }
        if (lockRes.warning)
            this.log.warn(lockRes.warning);
        if (!this.workspaceBaselines.has(sessionId)) {
            const baseline = await this.workspaceGuard.captureBaseline(workspacePath);
            this.workspaceBaselines.set(sessionId, baseline);
        }
    }
    releaseWorkspaceIfTerminal(sessionId, status) {
        if (isTerminalStatus(status))
            this.workspaceGuard.releaseLock(sessionId);
    }
    skipIdempotentStep(sessionId, toolName, command, workspacePath, snapshot, callId) {
        const kind = idempotencyKindFor(toolName, command);
        if (kind === undefined)
            return undefined;
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
    recordObservedExecutions(sessionId, view, facts) {
        const workspacePath = view.header?.cwd ?? this.workspaceBaselines.get(sessionId)?.workspacePath;
        if (workspacePath === undefined || workspacePath === '')
            return;
        this.recordObservedExecutionFacts(sessionId, workspacePath, facts);
    }
    recordObservedExecutionFacts(sessionId, workspacePath, facts) {
        const baseline = this.workspaceBaselines.get(sessionId);
        const goalId = this.goalStore.get(sessionId)?.goal_id ?? `goal-${sessionId}`;
        for (const tool of facts.tools) {
            if (!tool.ok)
                continue;
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
            if (kind === undefined)
                continue;
            if (this.recordedExecutionEvidenceCalls.has(key))
                continue;
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
            if (this.idempotencyManager.check(fingerprint, { sessionId, workspacePath }) !== null)
                continue;
            this.idempotencyManager.recordSuccess(fingerprint, {
                kind,
                status: isVerifiedKind(kind) ? 'passed' : 'applied',
                summary: tool.resultText,
                sessionId,
                workspacePath,
            });
        }
    }
    executionFingerprintExtra(snapshot) {
        return {
            workspace_fingerprint: snapshot?.workspaceFingerprint ?? '',
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
        };
    }
    async refreshWorkspaceBaselineIfNeeded(sessionId, workspacePath) {
        if (!this.pendingBaselineRefresh.delete(sessionId))
            return;
        this.workspaceBaselines.set(sessionId, await this.workspaceGuard.captureBaseline(workspacePath));
    }
    noteMutation(workspacePath, sessionId, toolName, command, callId) {
        const key = `${sessionId}:${callId ?? toolName}:${command ?? ''}`;
        if (this.recordedMutationCalls.has(key))
            return;
        this.rememberMutationCall(key);
        this.workspaceGuard.recordMutation(workspacePath, {
            sessionId,
            goalId: this.goalStore.get(sessionId)?.goal_id ?? `goal-${sessionId}`,
            stepId: callId,
            type: idempotencyKindFor(toolName, command) ?? toolName,
            details: command,
        });
    }
    rememberMutationCall(key) {
        this.recordedMutationCalls.add(key);
        while (this.recordedMutationCalls.size > 2048) {
            const oldest = this.recordedMutationCalls.values().next().value;
            if (oldest === undefined)
                break;
            this.recordedMutationCalls.delete(oldest);
        }
    }
    rememberExecutionEvidenceCall(key) {
        rememberCappedSet(this.recordedExecutionEvidenceCalls, key);
    }
    rememberObservedSuccessfulMutationCall(key) {
        rememberCappedSet(this.observedSuccessfulMutationCalls, key);
    }
    rememberPendingExecutionFingerprint(key, value) {
        if (this.pendingExecutionFingerprints.has(key))
            this.pendingExecutionFingerprints.delete(key);
        this.pendingExecutionFingerprints.set(key, value);
        while (this.pendingExecutionFingerprints.size > 2048) {
            const oldest = this.pendingExecutionFingerprints.keys().next().value;
            if (oldest === undefined)
                break;
            this.pendingExecutionFingerprints.delete(oldest);
        }
    }
}
