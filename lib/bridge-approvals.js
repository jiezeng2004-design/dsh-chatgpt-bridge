/**
 * Approval and user-question handling: owns the parked approval/question
 * registries' lifecycle on the bridge's behalf (the Maps themselves live on the
 * Bridge instance and are shared by reference). Covers registering the DSH
 * approval/user-question seams or mirroring the Web mux, deciding incoming
 * approval requests (workspace drift, idempotent-step skipping, goal
 * constraints, bridge policy), parking asks, settling them from ChatGPT
 * decisions (`approve` / `answerQuestion`), fail-closed cleanup on stop, and the
 * waiting-state view derived from parked asks plus undecided session events.
 */
import { randomUUID } from 'node:crypto';
import { BridgeError, } from './bridge-types.js';
import { approvalEvents, isMutatingTool } from './bridge-helpers.js';
import { redactText } from './redact.js';
import { openAskUserQuestions, undecidedApprovals } from './status.js';
import { changedFileCountOf, commandForCall, filePathsForCall, foldGoalFacts } from './goal-facts.js';
import { appendGoalEvent } from './goal-control.js';
import { classesForTool, evaluateConstraint } from './goal-constraints.js';
import { evaluateApproval } from './approval-policy.js';
import { idempotencyKindFor } from './execution-idempotency.js';
import { isPathInsideWorkspace } from './paths.js';
import { asApiProxy, cancelQuestion, compositionHasWebGateway, respondApproval, respondQuestion, startMuxMirror, } from './web-gateway.js';
export class ApprovalBroker {
    deps;
    ctx;
    log;
    managed;
    approvals;
    questions;
    goalStore;
    workspace;
    workspaceGuard;
    now;
    noteGoalEvent;
    questionSeq = 0;
    started = false;
    muxAbort;
    webOwnsApprovals = false;
    approvalsEnabled = false;
    questionsEnabled = false;
    constructor(deps) {
        this.deps = deps;
        this.ctx = deps.ctx;
        this.log = deps.log;
        this.managed = deps.managed;
        this.approvals = deps.approvals;
        this.questions = deps.questions;
        this.goalStore = deps.goalStore;
        this.workspace = deps.workspace;
        this.workspaceGuard = deps.workspaceGuard;
        this.now = deps.now;
        this.noteGoalEvent = deps.noteGoalEvent;
    }
    get apiProxy() {
        return this.deps.getApiProxy();
    }
    set apiProxy(api) {
        this.deps.setApiProxy(api);
    }
    get approvalPolicy() {
        return this.deps.getApprovalPolicy();
    }
    /** Register the approval answerer and the user-questions provider. */
    start() {
        if (this.started)
            return;
        this.started = true;
        this.apiProxy = asApiProxy(this.ctx.get('apiProxy'));
        // api-proxy starts later than this plugin (more inject deps). If the
        // loader already lists it, do not steal the userQuestions slot.
        const webGatewayPending = this.apiProxy === undefined && compositionHasWebGateway(this.ctx);
        if (this.apiProxy !== undefined || webGatewayPending) {
            // Same process as DSH Web: observe mux, settle through respond(). Do not
            // steal the single userQuestions slot or the approval waterfall.
            this.webOwnsApprovals = true;
            this.approvalsEnabled = true;
            this.questionsEnabled = true;
            const attachMux = (api) => {
                this.apiProxy = api;
                this.muxAbort?.abort();
                this.muxAbort = new AbortController();
                startMuxMirror(api, {
                    onApprovalRequested: (pending) => {
                        this.approvals.set(pending.approvalId, {
                            id: pending.approvalId,
                            sessionId: pending.sessionId,
                            toolName: pending.toolName,
                            callId: pending.callId,
                            reason: pending.reason,
                            muxRpcId: pending.rpcId,
                            resolve: () => { },
                        });
                        this.log.info(`approval ${pending.approvalId} mirrored from Web mux for session ${pending.sessionId}`);
                    },
                    onApprovalResolved: (_sessionId, approvalId) => {
                        this.approvals.delete(approvalId);
                    },
                    onQuestionRequested: (pending) => {
                        this.questions.set(pending.rpcId, {
                            id: pending.rpcId,
                            sessionId: pending.sessionId,
                            questions: pending.questions,
                            muxRpcId: pending.rpcId,
                            resolve: () => { },
                        });
                        this.log.info(`question ${pending.rpcId} mirrored from Web mux for session ${pending.sessionId}`);
                    },
                    onQuestionResolved: (_sessionId, questionRpcId) => {
                        this.questions.delete(questionRpcId);
                    },
                }, this.muxAbort.signal, (message) => this.log.warn(`apiProxy mux mirror ended: ${redactText(message)}`));
            };
            if (this.apiProxy !== undefined) {
                attachMux(this.apiProxy);
            }
            else {
                this.ctx.inject(['apiProxy'], () => {
                    const api = asApiProxy(this.ctx.get('apiProxy'));
                    if (api !== undefined)
                        attachMux(api);
                });
            }
        }
        else {
            // Current hosts expose scoped waterfalls in both Web and headless mode.
            this.webOwnsApprovals = false;
            this.approvalsEnabled = true;
            const userQuestions = this.ctx.get('userQuestions');
            if (userQuestions !== undefined) {
                try {
                    this.ctx.on('user-questions/request', async (request, next) => {
                        if (request.agent !== undefined && !this.managed.has(request.agent.id))
                            return next();
                        if (request.signal?.aborted)
                            return { answers: [] };
                        const id = `question-${++this.questionSeq}`;
                        const sessionId = request.agent?.id;
                        return new Promise((resolve) => {
                            const settle = (answer) => {
                                request.signal?.removeEventListener('abort', abort);
                                this.questions.delete(id);
                                resolve(answer);
                            };
                            const abort = () => settle({ answers: [] });
                            this.questions.set(id, { id, sessionId, questions: request.questions, resolve: settle });
                            request.signal?.addEventListener('abort', abort, { once: true });
                            this.log.info(`question ${id} pending for session ${sessionId ?? '(no agent)'}`);
                        });
                    }, { prepend: true });
                    this.questionsEnabled = true;
                }
                catch (error) {
                    this.log.warn(`userQuestions provider slot already taken by another plugin; questions will flow through it: ${redactText(String(error))}`);
                    this.questionsEnabled = false;
                }
            }
        }
        this.ctx.on('approval/request', (request, next) => this.decideApproval(request, next), { prepend: true });
        this.ctx.effect(() => () => {
            this.muxAbort?.abort();
            for (const pending of [...this.approvals.values()]) {
                this.approvals.delete(pending.id);
                pending.resolve('cancelled');
            }
            for (const pending of [...this.questions.values()]) {
                this.questions.delete(pending.id);
                pending.resolve({ answers: [] });
            }
        });
    }
    /** Parked + undecided approvals and questions for one session. */
    waitingFor(sessionId, events) {
        const seenApprovals = new Set();
        const approvals = [];
        for (const pending of this.approvals.values()) {
            if (pending.sessionId !== sessionId)
                continue;
            seenApprovals.add(pending.id);
            approvals.push({
                approval_id: pending.id,
                session_id: pending.sessionId,
                tool_name: pending.toolName,
                ...(pending.callId === undefined ? {} : { call_id: pending.callId }),
                ...(pending.reason === undefined ? {} : { reason: pending.reason }),
            });
        }
        if (events !== undefined) {
            for (const item of undecidedApprovals(events)) {
                if (seenApprovals.has(item.id))
                    continue;
                approvals.push({
                    approval_id: item.id,
                    session_id: sessionId,
                    tool_name: item.toolName,
                    ...(item.callId === undefined ? {} : { call_id: item.callId }),
                    ...(item.reason === undefined ? {} : { reason: item.reason }),
                });
            }
        }
        const seenQuestions = new Set();
        const questions = [];
        for (const pending of this.questions.values()) {
            if (pending.sessionId !== sessionId)
                continue;
            seenQuestions.add(pending.id);
            questions.push({
                question_id: pending.id,
                ...(pending.sessionId === undefined ? {} : { session_id: pending.sessionId }),
                questions: pending.questions,
            });
        }
        if (events !== undefined) {
            for (const item of openAskUserQuestions(events)) {
                if (seenQuestions.has(item.callId))
                    continue;
                let parsed;
                try {
                    parsed = JSON.parse(item.arguments);
                }
                catch {
                    parsed = undefined;
                }
                questions.push({
                    question_id: item.callId,
                    session_id: sessionId,
                    questions: parsed?.questions ?? [],
                });
            }
        }
        return { approvals, questions };
    }
    async failClosedWaiting(sessionId) {
        for (const pending of [...this.approvals.values()]) {
            if (pending.sessionId !== sessionId)
                continue;
            this.approvals.delete(pending.id);
            let settled = false;
            if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
                try {
                    const receipt = await respondApproval(this.apiProxy, pending.muxRpcId, sessionId, pending.id, 'rejected');
                    settled = receipt.accepted;
                }
                catch {
                    settled = false;
                }
            }
            if (!settled)
                pending.resolve('cancelled');
            else
                pending.resolve('rejected');
        }
        for (const pending of [...this.questions.values()]) {
            if (pending.sessionId !== sessionId)
                continue;
            this.questions.delete(pending.id);
            if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
                try {
                    await cancelQuestion(this.apiProxy, pending.muxRpcId);
                }
                catch {
                    // local fail-closed below
                }
            }
            pending.resolve({ answers: [] });
        }
    }
    /**
     * Decide a DSH approval/request for a managed session.
     * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
     * deny/reject always remain reachable even if approve is blocked.
     */
    async decideApproval(request, next = () => Promise.resolve('rejected')) {
        if (!this.managed.has(request.agent.id))
            return next();
        const events = approvalEvents(request.agent.session);
        const command = commandForCall(events, request.callId);
        const workspacePath = request.agent.session?.header?.cwd
            ?? this.workspace.baselineOf(request.agent.id)?.workspacePath;
        const writeOperation = classesForTool(request.toolName, command).includes('filesystem.write');
        const targetPaths = filePathsForCall(events, request.callId);
        const externalWrite = writeOperation && (workspacePath === undefined
            || targetPaths.length === 0
            || targetPaths.some((path) => !isPathInsideWorkspace(path, workspacePath)));
        const evalDecision = evaluateApproval(request.toolName, command, this.approvalPolicy, { externalWrite });
        if (workspacePath !== undefined && workspacePath !== '') {
            this.workspace.recordObservedExecutionFacts(request.agent.id, workspacePath, foldGoalFacts(events));
            await this.workspace.refreshWorkspaceBaselineIfNeeded(request.agent.id, workspacePath);
        }
        const baseline = this.workspace.baselineOf(request.agent.id);
        const mutatingOperation = isMutatingTool(request.toolName, command);
        const needsCurrentSnapshot = mutatingOperation
            || idempotencyKindFor(request.toolName, command) !== undefined;
        const currentSnapshot = workspacePath !== undefined && workspacePath !== '' && needsCurrentSnapshot
            ? await this.workspaceGuard.captureBaseline(workspacePath)
            : undefined;
        if (workspacePath && baseline && mutatingOperation) {
            const drift = await this.workspaceGuard.detectDrift(workspacePath, baseline, request.agent.id, currentSnapshot);
            if (drift.drifted) {
                this.log.warn(`Workspace drift detected on ${request.agent.id}: ${drift.details}`);
                this.noteGoalEvent(request.agent.id, 'constraint_rejected', {
                    metadata: {
                        reason: 'WORKSPACE_DRIFT',
                        details: drift.details,
                        originating_session_id: drift.originatingSessionId,
                    },
                });
                return 'rejected';
            }
        }
        if (workspacePath !== undefined && workspacePath !== '') {
            const skip = this.workspace.skipIdempotentStep(request.agent.id, request.toolName, command, workspacePath, currentSnapshot ?? baseline, request.callId);
            if (skip !== undefined)
                return 'rejected';
        }
        // A proven no-op replay is safe to fold before the normal constraint
        // rejection path. New work still goes through constraints and approval.
        if (this.rejectConstraint(request))
            return 'rejected';
        if (evalDecision.decision === 'auto_approve') {
            if (workspacePath && mutatingOperation) {
                this.workspace.noteMutation(workspacePath, request.agent.id, request.toolName, command, request.callId);
            }
            this.log.info(`auto-approving L0/L1 tool ${request.toolName} (capability ${evalDecision.capability}) for session ${request.agent.id}`);
            return 'allowed-once';
        }
        if (evalDecision.decision === 'deny') {
            this.log.info(`policy denied tool ${request.toolName} (capability ${evalDecision.capability}) for session ${request.agent.id}: ${evalDecision.reason}`);
            this.noteGoalEvent(request.agent.id, 'constraint_rejected', {
                metadata: {
                    reason: evalDecision.reason,
                    tool: request.toolName,
                    layer: 'bridge_policy',
                    capability: evalDecision.capability,
                },
            });
            return 'rejected';
        }
        if (this.webOwnsApprovals)
            return next();
        const id = `approval-${randomUUID()}`;
        const pending = {
            id,
            sessionId: request.agent.id,
            toolName: request.toolName,
            callId: request.callId,
            reason: request.reason,
            command,
            capability: evalDecision.capability,
            level: evalDecision.level,
            resolve: () => { },
        };
        const decision = new Promise((resolve) => {
            pending.resolve = resolve;
        });
        this.approvals.set(id, pending);
        this.noteGoalEvent(request.agent.id, 'approval_requested', {
            metadata: {
                tool: request.toolName,
                approval_id: id,
                capability: evalDecision.capability,
                level: evalDecision.level,
                command,
                layer: 'user',
            },
        });
        this.log.info(`approval ${id} pending for session ${request.agent.id} (tool ${request.toolName}, level ${evalDecision.level})`);
        request.signal?.addEventListener('abort', () => {
            if (this.approvals.delete(id)) {
                this.log.info(`approval ${id} withdrawn (turn aborted)`);
                pending.resolve('cancelled');
            }
        }, { once: true });
        return decision;
    }
    rejectConstraint(request) {
        const record = this.goalStore.get(request.agent.id);
        if (record === undefined)
            return false;
        const hasRules = Object.keys(record.constraints).length > 0 || record.completed_action_kinds.length > 0;
        if (!hasRules)
            return false;
        const events = approvalEvents(request.agent.session);
        const command = commandForCall(events, request.callId);
        const changed = changedFileCountOf(events);
        const decision = evaluateConstraint({
            constraints: record.constraints,
            completedKinds: record.completed_action_kinds,
            changedFileCount: changed,
            toolName: request.toolName,
            command,
        });
        if (decision.allow)
            return false;
        this.goalStore.put(appendGoalEvent(record, 'constraint_rejected', {
            now: this.now(),
            ...(decision.kind === undefined ? {} : { step_id: decision.kind }),
            metadata: {
                reason: decision.reason,
                tool: request.toolName,
                ...(decision.action_class === undefined ? {} : { action_class: decision.action_class }),
            },
        }));
        this.log.info(`constraint rejected ${request.toolName} on ${request.agent.id}: ${decision.reason}`);
        return true;
    }
    async answerQuestion(questionId, sessionId, answer) {
        const pending = [...this.questions.values()].find((item) => item.id === questionId && (sessionId === undefined || item.sessionId === sessionId));
        if (pending === undefined) {
            throw new BridgeError('QUESTION_NOT_FOUND', `no pending question ${questionId}`);
        }
        const question = pending.questions[0];
        const labels = new Set(question?.options?.map((option) => option.label) ?? []);
        if (answer.selected.some((label) => !labels.has(label))) {
            throw new BridgeError('INVALID_ANSWER', `selected option(s) are not offered by question ${questionId}`);
        }
        if (question?.multiSelect !== true && answer.selected.length > 1) {
            throw new BridgeError('INVALID_ANSWER', `question ${questionId} is single-select`);
        }
        this.questions.delete(questionId);
        const resolved = {
            answers: [
                {
                    id: pending.questions[0]?.id ?? questionId,
                    selected: answer.selected,
                    ...(answer.custom === undefined ? {} : { custom: answer.custom }),
                },
            ],
        };
        if (pending.muxRpcId !== undefined && this.apiProxy !== undefined && pending.sessionId !== undefined) {
            const receipt = await respondQuestion(this.apiProxy, pending.muxRpcId, pending.sessionId, resolved);
            if (!receipt.accepted) {
                throw new BridgeError('QUESTION_NOT_FOUND', `Web gateway rejected answer for ${questionId}: ${receipt.reason ?? 'not-pending'}`);
            }
        }
        else {
            pending.resolve(resolved);
        }
        this.log.info(`question ${questionId} answered`);
        if (pending.sessionId !== undefined) {
            this.noteGoalEvent(pending.sessionId, 'question_answered', { metadata: { question_id: questionId } });
        }
        return { answered: true };
    }
    async approve(sessionId, approvalId, decision) {
        const pending = this.approvals.get(approvalId);
        if (pending === undefined) {
            throw new BridgeError('APPROVAL_NOT_FOUND', `no pending approval ${approvalId}`);
        }
        if (pending.sessionId !== sessionId) {
            throw new BridgeError('APPROVAL_SESSION_MISMATCH', `approval ${approvalId} belongs to session ${pending.sessionId}`);
        }
        const outcome = decision === 'approve' ? 'allowed-once' : 'rejected';
        if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
            const receipt = await respondApproval(this.apiProxy, pending.muxRpcId, sessionId, approvalId, outcome);
            if (!receipt.accepted) {
                if (decision === 'approve') {
                    throw new BridgeError('APPROVAL_UNREACHABLE', `approve is blocked by the platform security layer for ${approvalId}: ${receipt.reason ?? 'not-pending'}. reject or dsh_stop_goal remains reachable.`, {
                        layer: 'platform',
                        reject_reachable: true,
                        cancel_reachable: true,
                        approval_id: approvalId,
                    });
                }
                this.approvals.delete(approvalId);
                pending.resolve('rejected');
                this.noteGoalEvent(sessionId, 'approval_resolved', {
                    metadata: { approval_id: approvalId, decision: 'reject', layer: 'platform', fail_closed: true },
                });
                this.log.info(`approval ${approvalId} fail-closed rejected after platform blocked mux respond`);
                return {
                    approval_id: approvalId,
                    session_id: sessionId,
                    decision: 'reject',
                    outcome: 'rejected',
                    layer: 'platform',
                    fail_closed: true,
                };
            }
        }
        else {
            pending.resolve(outcome);
        }
        this.approvals.delete(approvalId);
        if (decision === 'approve') {
            const workspacePath = this.workspace.baselineOf(sessionId)?.workspacePath;
            if (workspacePath && isMutatingTool(pending.toolName, pending.command)) {
                this.workspace.noteMutation(workspacePath, sessionId, pending.toolName, pending.command, pending.callId);
            }
        }
        this.log.info(`approval ${approvalId} decided: ${decision}`);
        this.noteGoalEvent(sessionId, 'approval_resolved', {
            metadata: { approval_id: approvalId, decision, layer: 'user' },
        });
        return { approval_id: approvalId, session_id: sessionId, decision, outcome, layer: 'user' };
    }
}
