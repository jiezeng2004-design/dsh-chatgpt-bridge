/**
 * Bridge core: maps MCP operations onto the DSH capability seams. The bridge
 * never re-implements DSH — it drives ctx.agents / ctx.sessions /
 * ctx.sessionPersistence / ctx.sessionTitle / ctx.workspaceRegistry and
 * answers ctx.approval + ctx.userQuestions through their plugin seams.
 *
 * `Bridge` is the facade: it owns session loading, workspace resolution,
 * session/result views and the shared state (parked approvals/questions, goal
 * store, workspace guard, idempotency manager), and delegates to collaborators:
 *   - bridge-approvals.ts      approval/question handling (ApprovalBroker)
 *   - bridge-workspace.ts      locks, baselines, execution evidence (WorkspaceTracker)
 *   - bridge-goal-view.ts      goal observation and projections (GoalObserver)
 *   - bridge-goal-lifecycle.ts goal start/update/wait/stop (GoalLifecycle)
 *   - bridge-types.ts / bridge-helpers.ts  shared types and pure helpers
 */
import { randomUUID } from 'node:crypto';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { inspectPersistedSession, persistedHeader, sessionEvents } from './session-persistence-compat.js';
import { redactText } from './redact.js';
import { deriveStatus, foldPendingMessages } from './status.js';
import { assistantTextForTurn, changedFilesForTurn, lastEventTime, lastTurnSpan, summarizeMessages, toolCallsForTurn, } from './session-view.js';
import { GoalControlStore, fileStoreIo, goalControlDir, } from './goal-control.js';
import { DEFAULT_APPROVAL_POLICY } from './approval-policy.js';
import { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { ExecutionIdempotencyManager } from './execution-idempotency.js';
import { buildResultSchema, inspectCredentials } from './result-schema.js';
import { SecretStore } from './control/secret-store.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
import { pathsEqual } from './paths.js';
import { BridgeError, } from './bridge-types.js';
import { dshVersion, iso, truncate } from './bridge-helpers.js';
import { ApprovalBroker } from './bridge-approvals.js';
import { WorkspaceTracker } from './bridge-workspace.js';
import { GoalObserver, recordGoalEvent } from './bridge-goal-view.js';
import { GoalLifecycle } from './bridge-goal-lifecycle.js';
export { normalizePath } from './paths.js';
export { BridgeError } from './bridge-types.js';
export { dshVersion } from './bridge-helpers.js';
/** The bridge service. One instance per plugin activation. */
export class Bridge {
    ctx;
    cfg;
    log;
    /** Sessions created through this bridge (approval answering scope). */
    managed = new Set();
    approvals = new Map();
    questions = new Map();
    goalStore;
    apiProxy;
    workspace;
    broker;
    observer;
    lifecycle;
    workspaceGuard = new WorkspaceConcurrencyGuard();
    idempotencyManager = new ExecutionIdempotencyManager();
    approvalPolicy = DEFAULT_APPROVAL_POLICY;
    /** Test hooks for bounded wait loops. */
    now = () => Date.now();
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    constructor(ctx, cfg, log) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.log = log;
        if (cfg.approvalPolicy) {
            this.approvalPolicy = { ...DEFAULT_APPROVAL_POLICY, ...cfg.approvalPolicy };
        }
        const home = typeof cfg.dshHome === 'string' && cfg.dshHome !== '' ? cfg.dshHome : undefined;
        this.goalStore = new GoalControlStore(home === undefined ? undefined : fileStoreIo(goalControlDir(home)));
        // Collaborators read mutable Bridge state (apiProxy, approvalPolicy, now,
        // sleep) through closures so test overrides stay live.
        const noteGoalEvent = (sessionId, type, extra) => this.noteGoalEvent(sessionId, type, extra);
        this.workspace = new WorkspaceTracker({
            ctx,
            log,
            workspaceGuard: this.workspaceGuard,
            idempotencyManager: this.idempotencyManager,
            goalStore: this.goalStore,
            noteGoalEvent,
        });
        this.broker = new ApprovalBroker({
            ctx,
            log,
            managed: this.managed,
            approvals: this.approvals,
            questions: this.questions,
            goalStore: this.goalStore,
            workspace: this.workspace,
            workspaceGuard: this.workspaceGuard,
            getApiProxy: () => this.apiProxy,
            setApiProxy: (api) => { this.apiProxy = api; },
            getApprovalPolicy: () => this.approvalPolicy,
            now: () => this.now(),
            noteGoalEvent,
        });
        this.observer = new GoalObserver({
            goalStore: this.goalStore,
            workspace: this.workspace,
            now: () => this.now(),
            waitingFor: (sessionId, events) => this.waitingFor(sessionId, events),
            statusOf: (sessionId, view) => this.statusOf(sessionId, view),
        });
        this.lifecycle = new GoalLifecycle({
            ctx,
            goalStore: this.goalStore,
            idempotencyManager: this.idempotencyManager,
            workspaceGuard: this.workspaceGuard,
            workspace: this.workspace,
            broker: this.broker,
            observer: this.observer,
            now: () => this.now(),
            sleep: (ms) => this.sleep(ms),
            noteGoalEvent,
            adopt: (sessionId) => this.adopt(sessionId),
            loadView: (sessionId) => this.loadView(sessionId),
            statusOf: (sessionId, view) => this.statusOf(sessionId, view),
            ensureAgent: (sessionId) => this.ensureAgent(sessionId),
            resolveWorkspace: (input) => this.resolveWorkspace(input),
            createSession: (workspaceInput, title, initialMessage) => this.createSession(workspaceInput, title, initialMessage),
            sendMessage: (sessionId, message) => this.sendMessage(sessionId, message),
        });
    }
    // ── lifecycle ─────────────────────────────────────────────────────────────
    /** Register the approval answerer and the user-questions provider. */
    start() {
        this.broker.start();
    }
    adopt(sessionId) {
        this.managed.add(sessionId);
    }
    /** Count of bridge-created sessions still live. */
    managedCount() {
        return this.managed.size;
    }
    // ── model selection + composition (mirrors the web api-proxy) ─────────────
    agentOptions() {
        const defaults = this.ctx.get('agentDefaultModel');
        if (defaults !== undefined) {
            const selection = defaults.currentSelection();
            return { provider: selection.provider, model: selection.model };
        }
        return { provider: 'deepseek-official', model: 'deepseek-flash' };
    }
    /**
     * DSH 0.2.2 owns model selection on the Agent (`agent.model`): resumes keep
     * the recorded choice and fall back to the live `agentOptions()` route. The
     * bridge never selects a model itself; it only installs the scoped
     * model-switch notice listener.
     */
    installSelection(agentCtx) {
        installModelSelection(agentCtx);
    }
    /** Compose the preset+selection setup used at agent creation/resume. */
    async composeSetupFor(presetId) {
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined) {
            return {
                setup: (agentCtx) => {
                    this.installSelection(agentCtx);
                },
            };
        }
        const resolvedId = presetId ?? (await presets.resolve(undefined)).id;
        return {
            agentPreset: resolvedId,
            setup: async (agentCtx) => {
                this.installSelection(agentCtx);
                await presets.mount(agentCtx, resolvedId);
            },
        };
    }
    // ── session loading ───────────────────────────────────────────────────────
    async loadView(sessionId) {
        const liveAgent = this.ctx.agents.get(SessionId(sessionId));
        if (liveAgent !== undefined) {
            return { agent: liveAgent, session: liveAgent.session, events: sessionEvents(liveAgent.session), header: liveAgent.session.header };
        }
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
            throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
        }
        try {
            const inspected = await inspectPersistedSession(persistence, SessionId(sessionId));
            return { events: inspected.events, header: inspected.meta };
        }
        catch {
            throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
        }
    }
    /** Resolve a live agent, resuming the persisted session when needed. */
    async ensureAgent(sessionId) {
        const live = this.ctx.agents.get(SessionId(sessionId));
        if (live !== undefined)
            return live;
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
            throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
        }
        let inspected;
        try {
            inspected = await inspectPersistedSession(persistence, SessionId(sessionId));
        }
        catch {
            throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
        }
        // Replay the official preset projection so a blank-session preset change
        // survives a cold resume, rather than using only the creation header.
        const presetId = inspected.events.reduce(agentPresetProjectionDefinition.apply, agentPresetProjectionDefinition.init(inspected.meta)) ?? undefined;
        const composition = await this.composeSetupFor(presetId);
        const { agent } = await this.ctx.agents.resume({
            resumeSessionId: SessionId(sessionId),
            agentOptions: this.agentOptions(),
            setup: composition.setup,
        });
        return agent;
    }
    // ── workspace boundary ────────────────────────────────────────────────────
    async listWorkspaces() {
        const registry = this.ctx.get('workspaceRegistry');
        if (registry === undefined) {
            throw new BridgeError('WORKSPACE_REGISTRY_UNAVAILABLE', 'no workspace registry is mounted in this profile');
        }
        return registry.list().map((workspace) => ({
            id: workspace.id,
            title: workspace.title,
            path: workspace.path,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
            sessionCount: workspace.sessionIds.length,
        }));
    }
    /**
     * Resolve a workspace reference (id, canonical path, or title) against the
     * REGISTERED workspace set only. Never auto-registers and never opens an
     * arbitrary path: an unregistered path is rejected.
     */
    async resolveWorkspace(input) {
        const registry = this.ctx.get('workspaceRegistry');
        if (registry === undefined) {
            throw new BridgeError('WORKSPACE_REGISTRY_UNAVAILABLE', 'no workspace registry is mounted in this profile');
        }
        const all = registry.list();
        const byId = all.find((workspace) => workspace.id === input);
        if (byId !== undefined)
            return byId;
        const byPath = all.find((workspace) => pathsEqual(workspace.path, input));
        if (byPath !== undefined)
            return byPath;
        const byTitle = all.find((workspace) => workspace.title === input);
        if (byTitle !== undefined)
            return byTitle;
        throw new BridgeError('WORKSPACE_NOT_FOUND', `no registered workspace matches "${input}"; sessions can only be created in workspaces DSH already registered (dsh_list_workspaces)`);
    }
    // ── operations ────────────────────────────────────────────────────────────
    async health() {
        const agents = this.ctx.agents.list();
        let persisted = 0;
        try {
            persisted = (await this.ctx.get('sessionPersistence')?.list())?.length ?? 0;
        }
        catch {
            persisted = -1;
        }
        const workspaces = this.ctx.get('workspaceRegistry')?.list() ?? [];
        return {
            status: 'ok',
            bridge: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
            dsh: { version: dshVersion() },
            runtime: { pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) },
            sessions: {
                live: agents.length,
                persisted: Math.max(persisted, 0),
                active: agents.filter((agent) => agent.status === 'running').length,
            },
            capabilities: {
                transports: this.cfg.transport === 'stdio' ? ['stdio'] : ['streamable-http'],
                authMode: this.cfg.authMode,
                workspaceRegistry: this.ctx.get('workspaceRegistry') !== undefined,
                sessionPersistence: this.ctx.get('sessionPersistence') !== undefined,
                agentPresets: this.ctx.get('agentPresets') !== undefined,
                userQuestions: this.broker.questionsEnabled,
                approvals: this.broker.approvalsEnabled,
                workspaces: workspaces.length,
                // DSH 0.2.2 Web provides `webApp` (renamed from `webRuntime`); `webRuntime` is kept only as a fallback.
                webSurface: this.apiProxy !== undefined || this.ctx.get('webApp') !== undefined || this.ctx.get('webRuntime') !== undefined,
                goalSupervision: true,
            },
        };
    }
    async createSession(workspaceInput, title, initialMessage) {
        const workspace = await this.resolveWorkspace(workspaceInput);
        const sessionId = `session-${randomUUID()}`;
        const composition = await this.composeSetupFor(undefined);
        let agent;
        try {
            const handle = await this.ctx.agents.create({
                sessionId: SessionId(sessionId),
                agentOptions: this.agentOptions(),
                meta: {
                    cwd: workspace.path,
                    ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
                },
                setup: composition.setup,
            });
            agent = handle.agent;
        }
        catch (error) {
            throw new BridgeError('SESSION_CREATE_FAILED', `failed to create DSH session in workspace "${workspace.title}": ${redactText(error instanceof Error ? error.message : String(error))}`);
        }
        this.adopt(sessionId);
        try {
            await workspace.attachSession(SessionId(sessionId));
        }
        catch (error) {
            this.log.warn(`session ${sessionId} could not attach to workspace ${workspace.id}: ${redactText(String(error))}`);
        }
        if (title !== undefined && title !== '') {
            try {
                this.ctx.sessionTitle?.rename(agent.session, title);
            }
            catch (error) {
                this.log.warn(`session ${sessionId} title rejected: ${redactText(String(error))}`);
            }
        }
        if (initialMessage !== undefined && initialMessage.trim() !== '') {
            agent.followup(createUserMessage({
                content: [{ type: 'text', text: initialMessage }],
                source: { kind: 'user' },
            }));
        }
        return this.viewOf(agent);
    }
    async sendMessage(sessionId, message) {
        if (message.trim() === '')
            throw new BridgeError('EMPTY_MESSAGE', 'message must not be empty');
        this.adopt(sessionId);
        const agent = await this.ensureAgent(sessionId);
        agent.followup(createUserMessage({
            content: [{ type: 'text', text: message }],
            source: { kind: 'user' },
        }));
        return { session_id: sessionId, accepted: true };
    }
    async cancelTask(sessionId) {
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (agent === undefined) {
            throw new BridgeError('SESSION_NOT_LIVE', `session ${sessionId} is not loaded; only live sessions can be cancelled`);
        }
        agent.cancel({ kind: 'user' });
        return { session_id: sessionId, cancelled: true };
    }
    waitingFor(sessionId, events) {
        return this.broker.waitingFor(sessionId, events);
    }
    async statusOf(sessionId, view) {
        const pending = view.agent !== undefined
            ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
            : foldPendingMessages(view.events);
        const waiting = this.waitingFor(sessionId, view.events);
        return deriveStatus({
            live: view.agent !== undefined,
            agentStatus: view.agent?.status,
            hasPendingInbox: pending.nextTurn + pending.nextStep > 0,
            pendingApprovals: waiting.approvals.length,
            pendingQuestions: waiting.questions.length,
            events: view.events,
        });
    }
    async titleOf(view) {
        if (view.session !== undefined) {
            try {
                return this.ctx.sessionTitle?.get(view.session)?.title;
            }
            catch {
                return undefined;
            }
        }
        try {
            return foldSessionTitle(view.events)?.title;
        }
        catch {
            return undefined;
        }
    }
    async viewOf(agent) {
        return this.getSession(agent.id, this.cfg.sessionMaxItems, this.cfg.sessionMaxChars);
    }
    async getSession(sessionId, maxItems, maxChars) {
        const view = await this.loadView(sessionId);
        const items = maxItems ?? this.cfg.sessionMaxItems;
        const chars = maxChars ?? this.cfg.sessionMaxChars;
        const pending = view.agent !== undefined
            ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
            : foldPendingMessages(view.events);
        const waiting = this.waitingFor(sessionId, view.events);
        const status = await this.statusOf(sessionId, view);
        const title = await this.titleOf(view);
        const span = lastTurnSpan(view.events);
        return {
            session_id: sessionId,
            ...(title === undefined ? {} : { title }),
            ...(view.header.cwd === undefined ? {} : { workspace: view.header.cwd }),
            status,
            created_at: iso(view.header.createdAt),
            updated_at: view.agent !== undefined ? lastEventTime(view.events) : undefined,
            ...(view.agent === undefined
                ? {}
                : { agent: { status: view.agent.status, inbox: { nextTurn: pending.nextTurn, nextStep: pending.nextStep } } }),
            pending,
            waiting,
            messages: summarizeMessages(view.events, items, chars),
            ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
            ...this.observer.goalFields(sessionId, view, status),
        };
    }
    async listSessions(options) {
        const persistence = this.ctx.get('sessionPersistence');
        const persisted = persistence === undefined ? [] : await persistence.list();
        const live = this.ctx.sessions.list();
        const byId = new Map();
        for (const row of persisted) {
            const header = persistedHeader(row);
            byId.set(header.id, header);
        }
        for (const session of live)
            byId.set(session.id, session.header);
        let rows = [...byId.values()];
        if (options.workspace !== undefined && options.workspace !== '') {
            const workspace = await this.resolveWorkspace(options.workspace);
            rows = rows.filter((header) => header.cwd !== undefined && pathsEqual(header.cwd, workspace.path));
        }
        rows.sort((a, b) => b.createdAt - a.createdAt);
        const offset = Math.max(options.offset ?? 0, 0);
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
        const page = rows.slice(offset, offset + limit);
        const out = [];
        for (const header of page) {
            const agent = this.ctx.agents.get(header.id);
            let title;
            if (agent !== undefined) {
                title = this.ctx.sessionTitle?.get(agent.session)?.title;
            }
            else {
                title = await this.cachedTitle(header);
            }
            const status = agent === undefined
                ? undefined
                : deriveStatus({
                    live: true,
                    agentStatus: agent.status,
                    hasPendingInbox: agent.inbox.nextTurn.length + agent.inbox.nextStep.length > 0,
                    pendingApprovals: this.waitingFor(header.id, sessionEvents(agent.session)).approvals.length,
                    pendingQuestions: this.waitingFor(header.id, sessionEvents(agent.session)).questions.length,
                    events: sessionEvents(agent.session),
                });
            out.push({
                session_id: header.id,
                ...(title === undefined ? {} : { title }),
                ...(header.cwd === undefined ? {} : { workspace: header.cwd }),
                ...(status === undefined ? {} : { status }),
                created_at: iso(header.createdAt),
                ...(agent === undefined ? {} : { updated_at: lastEventTime(sessionEvents(agent.session)) }),
            });
        }
        return out;
    }
    /** Zero-I/O cached title for a cold session, when a projection cache is mounted. */
    async cachedTitle(header) {
        const cache = this.ctx.get('sessionProjectionCache');
        if (cache === undefined)
            return undefined;
        try {
            const snapshot = cache.cachedSnapshot(header);
            const value = snapshot?.values?.title;
            if (typeof value === 'string' && value !== '')
                return value;
            if (value !== null && typeof value === 'object' && 'title' in value) {
                return value.title;
            }
            return undefined;
        }
        catch {
            return undefined;
        }
    }
    async getResult(sessionId, maxChars) {
        const view = await this.loadView(sessionId);
        const span = lastTurnSpan(view.events);
        if (span === undefined) {
            throw new BridgeError('NO_RESULT_YET', `session ${sessionId} has no turn yet; send a message first`);
        }
        const chars = maxChars ?? this.cfg.resultMaxChars;
        const items = this.cfg.resultMaxItems;
        const text = assistantTextForTurn(view.events, span.turn);
        const status = await this.statusOf(sessionId, view);
        const error = span.reason !== undefined && span.reason.kind === 'error'
            ? { code: span.reason.error.code, message: span.reason.error.message }
            : undefined;
        const resultSchema = await this.getStructuredResult(sessionId).catch(() => undefined);
        return {
            session_id: sessionId,
            status,
            turn: span.turn,
            summary: truncate(text, chars),
            assistant_text: truncate(text, chars),
            changed_files: changedFilesForTurn(view.events, span.turn),
            tool_calls: toolCallsForTurn(view.events, span.turn, items).map((call) => ({
                ...call,
                arguments: truncate(call.arguments, 500),
            })),
            ...(error === undefined ? {} : { error }),
            ...(resultSchema === undefined ? {} : { result_schema: resultSchema }),
        };
    }
    async getTaskStatus(sessionId) {
        const view = await this.loadView(sessionId);
        const status = await this.statusOf(sessionId, view);
        this.workspace.releaseWorkspaceIfTerminal(sessionId, status);
        const pending = view.agent !== undefined
            ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
            : foldPendingMessages(view.events);
        const span = lastTurnSpan(view.events);
        return {
            session_id: sessionId,
            status,
            live: view.agent !== undefined,
            ...(view.agent === undefined ? {} : { agent_status: view.agent.status }),
            pending,
            waiting: this.waitingFor(sessionId, view.events),
            ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
            updated_at: lastEventTime(view.events),
            ...this.observer.goalFields(sessionId, view, status),
        };
    }
    // ── Goal Supervision (delegates to GoalLifecycle) ─────────────────────────
    async createGoal(input) {
        return this.startGoal(input);
    }
    async reviseGoal(input) {
        return this.updateGoal({
            ...input,
            action: 'revise',
        });
    }
    async pauseGoal(sessionId) {
        return this.lifecycle.pauseGoal(sessionId);
    }
    async resumeGoal(sessionId, resumeSteps, requestId, workspaceLockOverride) {
        return this.updateGoal({
            session_id: sessionId,
            action: 'resume',
            resume_steps: resumeSteps,
            request_id: requestId,
            workspace_lock_override: workspaceLockOverride,
        });
    }
    async retryStep(sessionId, stepId, requestId, workspaceLockOverride) {
        return this.lifecycle.retryStep(sessionId, stepId, requestId, workspaceLockOverride);
    }
    async rerunStep(sessionId, stepId, requestId, workspaceLockOverride) {
        return this.lifecycle.rerunStep(sessionId, stepId, requestId, workspaceLockOverride);
    }
    async waitUntilActionRequired(sessionId, waitSeconds = 120) {
        return this.lifecycle.waitUntilActionRequired(sessionId, waitSeconds);
    }
    async getStructuredResult(sessionId) {
        this.adopt(sessionId);
        const view = await this.loadView(sessionId);
        const status = await this.statusOf(sessionId, view);
        const record = this.goalStore.get(sessionId);
        const workspace = view.header?.cwd ?? '';
        const warnings = [];
        if (record?.history) {
            for (const event of record.history) {
                if (event.metadata?.reason === 'WORKSPACE_DRIFT') {
                    const details = typeof event.metadata.details === 'string'
                        ? event.metadata.details
                        : 'Workspace drift detected';
                    warnings.push(details);
                }
            }
        }
        const lastMutation = workspace === '' ? undefined : this.workspaceGuard.getLastMutation(workspace);
        return buildResultSchema({
            sessionId,
            record,
            events: view.events,
            status,
            workspace,
            evidenceIds: this.idempotencyManager.listEvidence({ sessionId }).map((item) => item.evidenceId),
            credentialRefs: this.getCredentialStatus()
                .filter((item) => item.credentialAvailable)
                .map((item) => item.credentialRef),
            originatingStep: lastMutation?.stepId ?? lastMutation?.type,
            warnings,
        });
    }
    getCredentialStatus() {
        const home = this.cfg.dshHome;
        let runtimeKeyConfigured = false;
        if (typeof home === 'string' && home !== '') {
            try {
                runtimeKeyConfigured = new SecretStore(home).runtimeApiKeyConfigured();
            }
            catch {
                runtimeKeyConfigured = false;
            }
        }
        return inspectCredentials({
            env: process.env,
            ...(typeof home === 'string' && home !== '' ? { dshHome: home } : {}),
            runtimeKeyConfigured,
        });
    }
    async startGoal(input) {
        return this.lifecycle.startGoal(input);
    }
    async updateGoal(input) {
        return this.lifecycle.updateGoal(input);
    }
    async waitGoal(sessionId, waitSeconds) {
        return this.lifecycle.waitGoal(sessionId, waitSeconds);
    }
    async stopGoal(sessionId) {
        return this.lifecycle.stopGoal(sessionId);
    }
    noteGoalEvent(sessionId, type, extra) {
        recordGoalEvent(this.goalStore, () => this.now(), sessionId, type, extra);
    }
    // ── user questions / approvals (delegate to ApprovalBroker) ───────────────
    /**
     * Decide a DSH approval/request for a managed session.
     * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
     * deny/reject always remain reachable even if approve is blocked.
     */
    async decideApproval(request, next = () => Promise.resolve('rejected')) {
        return this.broker.decideApproval(request, next);
    }
    async answerQuestion(questionId, sessionId, answer) {
        return this.broker.answerQuestion(questionId, sessionId, answer);
    }
    async approve(sessionId, approvalId, decision) {
        return this.broker.approve(sessionId, approvalId, decision);
    }
    // ── introspection used by the MCP layer ───────────────────────────────────
    listManaged() {
        return [...this.managed];
    }
}
