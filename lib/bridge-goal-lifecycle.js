import { SessionId } from '@deepseek-ai/dsh-session';
import { BridgeError } from './bridge-types.js';
import { uniqueStrings } from './bridge-helpers.js';
import { RequestIdMap, WAIT_POLL_MS, buildSupervisedGoalContext, clampWaitSeconds, fingerprintStart, isActiveStatus, isTerminalStatus, isWaitingStatus, titleFromGoal, } from './goal.js';
import { successfulKinds } from './goal-facts.js';
import { detectDeferredKinds, resolveStepRefs } from './goal-graph.js';
import { applyRevision, createGoalRecord, isGoalSemanticallyEqual, pruneBlockers, } from './goal-control.js';
import { parseConstraints, parseExecutionMode } from './goal-constraints.js';
import { validateGoalPreflight } from './goal-preflight.js';
import { idempotencyKindFor } from './execution-idempotency.js';
import { pathsEqual } from './paths.js';
export class GoalLifecycle {
    ctx;
    goalStore;
    idempotencyManager;
    workspaceGuard;
    workspace;
    broker;
    observer;
    now;
    sleep;
    noteGoalEvent;
    adopt;
    loadView;
    statusOf;
    ensureAgent;
    resolveWorkspace;
    createSession;
    sendMessage;
    goalRequests = new RequestIdMap();
    constructor(deps) {
        this.ctx = deps.ctx;
        this.goalStore = deps.goalStore;
        this.idempotencyManager = deps.idempotencyManager;
        this.workspaceGuard = deps.workspaceGuard;
        this.workspace = deps.workspace;
        this.broker = deps.broker;
        this.observer = deps.observer;
        this.now = deps.now;
        this.sleep = deps.sleep;
        this.noteGoalEvent = deps.noteGoalEvent;
        this.adopt = deps.adopt;
        this.loadView = deps.loadView;
        this.statusOf = deps.statusOf;
        this.ensureAgent = deps.ensureAgent;
        this.resolveWorkspace = deps.resolveWorkspace;
        this.createSession = deps.createSession;
        this.sendMessage = deps.sendMessage;
    }
    async pauseGoal(sessionId) {
        this.adopt(sessionId);
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (agent !== undefined && agent.status === 'running') {
            agent.cancel({ kind: 'user' });
        }
        const record = this.goalStore.get(sessionId);
        const view = await this.loadView(sessionId);
        const status = await this.statusOf(sessionId, view);
        return {
            session_id: sessionId,
            status,
            paused: true,
            checkpoint_revision: record?.revision ?? 1,
        };
    }
    async retryStep(sessionId, stepId, requestId, workspaceLockOverride) {
        this.adopt(sessionId);
        const record = this.goalStore.get(sessionId);
        if (record !== undefined && record.active_blockers) {
            record.active_blockers = record.active_blockers.filter((b) => b.step_id !== stepId);
            this.goalStore.put(record);
        }
        return this.updateGoal({
            session_id: sessionId,
            action: 'resume',
            resume_steps: [stepId],
            revision_reason: `retry_step_${stepId}`,
            request_id: requestId,
            workspace_lock_override: workspaceLockOverride,
        });
    }
    async rerunStep(sessionId, stepId, requestId, workspaceLockOverride) {
        this.adopt(sessionId);
        const view = await this.loadView(sessionId);
        const observed = this.observer.observeGoal(sessionId, view, await this.statusOf(sessionId, view));
        const resolved = resolveStepRefs([stepId], observed.graph.steps);
        const resolvedKinds = new Set(resolved.kinds);
        const cacheKinds = uniqueStrings([
            ...resolved.contents.map((content) => idempotencyKindFor('', content) ?? ''),
            ...resolved.kinds.map((kind) => idempotencyKindFor(kind) ?? kind),
            idempotencyKindFor('', stepId) ?? '',
        ]);
        const record = this.goalStore.get(sessionId);
        if (record !== undefined) {
            record.completed_action_kinds = record.completed_action_kinds.filter((kind) => !resolvedKinds.has(kind));
            if (record.active_blockers) {
                const resolvedIds = new Set([stepId, ...resolved.ids, ...resolved.kinds]);
                record.active_blockers = record.active_blockers.filter((blocker) => !resolvedIds.has(blocker.step_id));
            }
            this.goalStore.put(record);
        }
        for (const kind of cacheKinds)
            this.idempotencyManager.invalidateKind(kind);
        return this.updateGoal({
            session_id: sessionId,
            action: 'revise',
            revision_reason: `rerun_step_${stepId}`,
            request_id: requestId,
            workspace_lock_override: workspaceLockOverride,
        });
    }
    async waitUntilActionRequired(sessionId, waitSeconds = 120) {
        this.adopt(sessionId);
        const seconds = Math.min(300, Math.max(1, waitSeconds));
        const started = this.now();
        const deadline = started + seconds * 1000;
        let view = await this.loadView(sessionId);
        let status = await this.statusOf(sessionId, view);
        while (isActiveStatus(status) && this.now() < deadline) {
            const remaining = deadline - this.now();
            if (remaining <= 0)
                break;
            await this.sleep(Math.min(WAIT_POLL_MS, remaining));
            view = await this.loadView(sessionId);
            status = await this.statusOf(sessionId, view);
            if (!isActiveStatus(status))
                break;
        }
        return this.observer.goalSnapshot(sessionId, view, status, this.now() - started, seconds);
    }
    async startGoal(input) {
        if (input.goal.trim() === '')
            throw new BridgeError('EMPTY_GOAL', 'goal must not be empty');
        // 1. Static Preflight Validation
        const preflight = validateGoalPreflight({
            goal: input.goal,
            plan: input.plan,
            constraints: input.constraints,
            mode: input.execution_mode,
        });
        if (!preflight.valid) {
            throw new BridgeError('GOAL_INVALID', `Goal contradicts constraints: ${preflight.conflicts.join('; ')}`);
        }
        const fingerprint = fingerprintStart(input);
        if (input.request_id !== undefined && input.request_id !== '') {
            const existing = this.goalRequests.get(input.request_id);
            if (existing !== undefined) {
                if (existing.fingerprint !== fingerprint) {
                    throw new BridgeError('REQUEST_ID_CONFLICT', `request_id "${input.request_id}" was already used with different start_goal arguments`);
                }
                this.adopt(existing.sessionId);
                const view = await this.loadView(existing.sessionId);
                return {
                    ...(await this.observer.mapGoalStart(existing.sessionId, view)),
                    existing_goal_reused: true,
                    revision_unchanged: true,
                };
            }
        }
        let sessionId = input.session_id;
        const resolvedWorkspace = await this.resolveWorkspace(input.workspace);
        const workspacePath = resolvedWorkspace.path;
        const isReadOnly = input.constraints?.read_only === true;
        const lockOverride = input.workspace_lock_override === true;
        if (sessionId === undefined || sessionId === '') {
            // Check if there is an active session on this workspace with identical Goal
            const activeSessions = this.ctx.agents.list();
            let reusedSessionId;
            for (const agent of activeSessions) {
                const record = this.goalStore.get(agent.id);
                if (record !== undefined && pathsEqual(agent.session.header?.cwd ?? '', workspacePath)) {
                    const view = await this.loadView(agent.id);
                    const status = await this.statusOf(agent.id, view);
                    if (!isActiveStatus(status) && !isWaitingStatus(status))
                        continue;
                    if (isGoalSemanticallyEqual(record, input.goal, input.plan, input.execution_mode, input.constraints)) {
                        reusedSessionId = agent.id;
                        break;
                    }
                }
            }
            if (reusedSessionId !== undefined) {
                sessionId = reusedSessionId;
                this.adopt(sessionId);
                const view = await this.loadView(sessionId);
                return {
                    ...(await this.observer.mapGoalStart(sessionId, view)),
                    existing_goal_reused: true,
                    revision_unchanged: true,
                };
            }
            this.workspace.assertMutableWorkspaceAvailable(workspacePath, undefined, lockOverride, isReadOnly);
            const created = await this.createSession(input.workspace, titleFromGoal(input.goal));
            sessionId = created.session_id;
        }
        else {
            this.adopt(sessionId);
        }
        const existingRecord = this.goalStore.get(sessionId);
        if (input.expected_revision !== undefined
            && existingRecord !== undefined
            && input.expected_revision !== existingRecord.revision) {
            throw new BridgeError('REVISION_CONFLICT', `expected_revision mismatch: expected ${input.expected_revision}, but current revision is ${existingRecord.revision}`);
        }
        await this.workspace.takeWorkspaceLock(workspacePath, sessionId, lockOverride, isReadOnly);
        // 3. Goal Deduplication on existing session
        if (existingRecord !== undefined &&
            isGoalSemanticallyEqual(existingRecord, input.goal, input.plan, input.execution_mode, input.constraints)) {
            if (input.request_id !== undefined && input.request_id !== '') {
                this.goalRequests.set(input.request_id, { sessionId, fingerprint });
            }
            const view = await this.loadView(sessionId);
            return {
                ...(await this.observer.mapGoalStart(sessionId, view)),
                existing_goal_reused: true,
                revision_unchanged: true,
            };
        }
        const record = this.applyStartOrRevise(sessionId, input);
        await this.sendMessage(sessionId, this.controlMessage(record, input.goal, input.plan, record.revision === 1 ? 'start' : 'revise'));
        if (input.request_id !== undefined && input.request_id !== '') {
            this.goalRequests.set(input.request_id, { sessionId, fingerprint });
        }
        const view = await this.loadView(sessionId);
        return this.observer.mapGoalStart(sessionId, view);
    }
    async updateGoal(input) {
        const sessionId = input.session_id;
        if (sessionId.trim() === '')
            throw new BridgeError('SESSION_REQUIRED', 'dsh_update_goal requires session_id');
        const action = input.action ?? 'revise';
        const fingerprint = fingerprintStart({
            workspace: input.workspace ?? '',
            goal: input.goal ?? '',
            plan: input.plan,
            session_id: sessionId,
            execution_mode: input.execution_mode,
            constraints: input.constraints,
            action,
        });
        if (input.request_id !== undefined && input.request_id !== '') {
            const existing = this.goalRequests.get(input.request_id);
            if (existing !== undefined) {
                if (existing.fingerprint !== fingerprint) {
                    throw new BridgeError('REQUEST_ID_CONFLICT', `request_id "${input.request_id}" was already used with different update_goal arguments`);
                }
                this.adopt(existing.sessionId);
                const view = await this.loadView(existing.sessionId);
                return {
                    ...(await this.observer.mapGoalStart(existing.sessionId, view)),
                    existing_goal_reused: true,
                    revision_unchanged: true,
                };
            }
        }
        this.adopt(sessionId);
        await this.ensureAgent(sessionId);
        const current = this.goalStore.get(sessionId);
        if (action === 'resume' && current === undefined) {
            throw new BridgeError('GOAL_NOT_FOUND', `no supervised goal on session ${sessionId}; resume will not create one`);
        }
        if (input.expected_revision !== undefined && current !== undefined && input.expected_revision !== current.revision) {
            throw new BridgeError('REVISION_CONFLICT', `expected_revision mismatch: expected ${input.expected_revision}, but current revision is ${current.revision}`);
        }
        const viewBefore = await this.loadView(sessionId);
        const workspacePath = viewBefore.header?.cwd ?? '';
        const isReadOnly = (input.constraints?.read_only ?? current?.constraints?.read_only) === true;
        const lockOverride = input.workspace_lock_override === true;
        if (workspacePath !== '') {
            this.workspace.assertMutableWorkspaceAvailable(workspacePath, sessionId, lockOverride, isReadOnly);
            await this.workspace.takeWorkspaceLock(workspacePath, sessionId, lockOverride, isReadOnly);
        }
        const observed = this.observer.observeGoal(sessionId, viewBefore, await this.statusOf(sessionId, viewBefore));
        const resolvedDefer = input.defer_steps === undefined
            ? { ids: [], kinds: [] }
            : resolveStepRefs(input.defer_steps, observed.graph.steps);
        const resolvedResume = input.resume_steps === undefined
            ? { ids: action === 'resume' ? [...(current?.deferred_step_ids ?? [])] : [], kinds: [] }
            : resolveStepRefs(input.resume_steps, observed.graph.steps);
        const detected = detectDeferredKinds(input.goal ?? current?.goal ?? '', input.plan ?? current?.plan);
        const deferIds = uniqueStrings([
            ...resolvedDefer.ids,
            ...resolvedDefer.kinds,
            ...detected,
            ...(action === 'defer' ? (input.defer_steps ?? []) : []),
        ]);
        const resumeIds = uniqueStrings([...resolvedResume.ids, ...resolvedResume.kinds]);
        let record = current ?? createGoalRecord({
            sessionId,
            goal: input.goal ?? 'continued goal',
            plan: input.plan,
            mode: parseExecutionMode(input.execution_mode),
            constraints: parseConstraints(input.constraints),
            now: this.now(),
        });
        if (current === undefined)
            this.goalStore.put(record);
        record = applyRevision(record, {
            ...(input.goal === undefined ? {} : { goal: input.goal }),
            ...(input.plan === undefined ? {} : { plan: input.plan }),
            ...(input.execution_mode === undefined ? {} : { mode: parseExecutionMode(input.execution_mode) }),
            ...(input.constraints === undefined ? {} : { constraints: parseConstraints(input.constraints) }),
            ...(input.expected_revision === undefined ? {} : { expectedRevision: input.expected_revision }),
            ...(deferIds.length === 0 ? {} : { deferredStepIds: deferIds }),
            ...(action === 'resume' ? { resumeStepIds: resumeIds } : {}),
            completedActionKinds: [...successfulKinds(observed.facts)],
            revisionReason: input.revision_reason ?? (action === 'resume' ? 'user_resumed_goal' : action === 'defer' ? 'user_deferred_step' : 'user_modified_goal'),
            now: this.now(),
        }, action === 'resume' ? 'goal_resumed' : 'goal_revised');
        pruneBlockers(record, successfulKinds(observed.facts));
        this.goalStore.put(record);
        const intent = action === 'resume' ? 'resume' : action === 'defer' ? 'defer' : 'revise';
        await this.sendMessage(sessionId, this.controlMessage(record, input.goal ?? record.goal, input.plan ?? record.plan, intent, resumeIds));
        if (input.request_id !== undefined && input.request_id !== '') {
            this.goalRequests.set(input.request_id, { sessionId, fingerprint });
        }
        const view = await this.loadView(sessionId);
        return this.observer.mapGoalStart(sessionId, view);
    }
    async waitGoal(sessionId, waitSeconds) {
        this.adopt(sessionId);
        const seconds = clampWaitSeconds(waitSeconds);
        const started = this.now();
        const deadline = started + seconds * 1000;
        let view = await this.loadView(sessionId);
        let status = await this.statusOf(sessionId, view);
        while (isActiveStatus(status) && this.now() < deadline) {
            const remaining = deadline - this.now();
            if (remaining <= 0)
                break;
            await this.sleep(Math.min(WAIT_POLL_MS, remaining));
            view = await this.loadView(sessionId);
            status = await this.statusOf(sessionId, view);
        }
        return this.observer.goalSnapshot(sessionId, view, status, this.now() - started, seconds);
    }
    async stopGoal(sessionId) {
        this.adopt(sessionId);
        this.workspaceGuard.releaseLock(sessionId);
        const view = await this.loadView(sessionId);
        const status = await this.statusOf(sessionId, view);
        if (isTerminalStatus(status) || status === 'unknown' || (status === 'idle' && view.agent === undefined)) {
            const warning = this.observer.cleanupGoalTemps(sessionId, view);
            return {
                session_id: sessionId,
                stopped: true,
                already_stopped: true,
                status,
                ...(warning === undefined ? {} : { cleanup_warning: warning }),
            };
        }
        if (status === 'idle' && view.agent !== undefined && !isActiveStatus(status)) {
            const warning = this.observer.cleanupGoalTemps(sessionId, view);
            return {
                session_id: sessionId,
                stopped: true,
                already_stopped: true,
                status,
                ...(warning === undefined ? {} : { cleanup_warning: warning }),
            };
        }
        await this.broker.failClosedWaiting(sessionId);
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (agent !== undefined)
            agent.cancel({ kind: 'user' });
        const warning = this.observer.cleanupGoalTemps(sessionId, view);
        this.noteGoalEvent(sessionId, 'goal_cancelled');
        return {
            session_id: sessionId,
            stopped: true,
            already_stopped: false,
            status: 'cancelled',
            ...(warning === undefined ? {} : { cleanup_warning: warning }),
        };
    }
    applyStartOrRevise(sessionId, input) {
        const existing = this.goalStore.get(sessionId);
        const mode = parseExecutionMode(input.execution_mode);
        const constraints = parseConstraints(input.constraints);
        const detected = detectDeferredKinds(input.goal, input.plan);
        if (existing === undefined) {
            const created = createGoalRecord({
                sessionId,
                goal: input.goal,
                plan: input.plan,
                mode,
                constraints,
                now: this.now(),
                revisionReason: 'goal_created',
            });
            if (detected.length > 0)
                created.deferred_step_ids = [...new Set(detected)];
            return this.goalStore.put(created);
        }
        return this.goalStore.put(applyRevision(existing, {
            goal: input.goal,
            plan: input.plan,
            mode,
            constraints,
            ...(input.expected_revision === undefined ? {} : { expectedRevision: input.expected_revision }),
            deferredStepIds: detected,
            revisionReason: 'user_modified_goal',
            now: this.now(),
        }, 'goal_revised'));
    }
    controlMessage(record, goal, plan, intent, resumeSteps) {
        return buildSupervisedGoalContext(record, goal, plan, intent, resumeSteps);
    }
}
