/**
 * Bridge core: maps MCP operations onto the DSH capability seams. The bridge
 * never re-implements DSH — it drives ctx.agents / ctx.sessions /
 * ctx.sessionPersistence / ctx.sessionTitle / ctx.workspaceRegistry and
 * answers ctx.approval + ctx.userQuestions through their plugin seams.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionLogOffset, } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { redactText } from './redact.js';
import { deriveStatus, foldPendingMessages, openAskUserQuestions, undecidedApprovals, } from './status.js';
import { assistantTextForTurn, changedFilesForTurn, lastEventTime, lastTurnSpan, summarizeMessages, toolCallsForTurn, } from './session-view.js';
import { DEFAULT_WAIT_SECONDS, RequestIdMap, WAIT_POLL_MS, buildSupervisedGoalContext, clampWaitSeconds, executionView, fingerprintStart, isActiveStatus, isTerminalStatus, isWaitingStatus, mapStartGoal, mapWaitGoal, titleFromGoal, } from './goal.js';
import { changedFileCountOf, commandForCall, filePathsForCall, foldGoalFacts, successfulKinds, } from './goal-facts.js';
import { reconcileTodos } from './goal-reconcile.js';
import { buildGoalGraph, deferredKindsOf, describeBlocked, detectDeferredKinds, inferBlockedKind, resolveStepRefs, } from './goal-graph.js';
import { PollCursorMap, computeProgressDelta, nextPollCursor } from './goal-delta.js';
import { cleanupTempResources, discoverTempResources } from './temp-resources.js';
import { GoalControlStore, appendGoalEvent, applyNativeGetGoalResult, applyRevision, createGoalRecord, fileStoreIo, goalControlDir, sliceHistory, supervisionGoal, isGoalSemanticallyEqual, pruneBlockers, } from './goal-control.js';
import { evaluateConstraint, findPostHocViolation, parseConstraints, parseExecutionMode, classesForTool, } from './goal-constraints.js';
import { validateGoalPreflight } from './goal-preflight.js';
import { evaluateApproval, DEFAULT_APPROVAL_POLICY } from './approval-policy.js';
import { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { ExecutionIdempotencyManager, idempotencyKindFor, isVerifiedKind } from './execution-idempotency.js';
import { buildResultSchema, inspectCredentials } from './result-schema.js';
import { isPathInsideWorkspace } from './paths.js';
import { SecretStore } from './control/secret-store.js';
import { asApiProxy, cancelQuestion, compositionHasWebGateway, respondApproval, respondQuestion, startMuxMirror, } from './web-gateway.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
import { pathsEqual } from './paths.js';
export { normalizePath } from './paths.js';
/** Typed bridge error with a stable machine-readable code. */
export class BridgeError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'BridgeError';
        this.code = code;
        if (details !== undefined)
            this.details = details;
    }
}
const require = createRequire(import.meta.url);
/** DSH version string, resolved lazily from the installed package. */
export function dshVersion() {
    try {
        return require('@deepseek-ai/dsh/package.json').version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + '…[truncated]';
}
function iso(ms) {
    return new Date(ms).toISOString();
}
/** Resolve effective session preset from its header and subsequent selection events. */
function resolveSessionPreset(header, events) {
    let preset = header.agentPreset;
    if (events !== undefined) {
        for (const event of events) {
            if (event.type === 'agent-preset/selected' &&
                typeof event.data === 'object' &&
                event.data !== null &&
                'agentPreset' in event.data) {
                preset = event.data.agentPreset;
            }
        }
    }
    return preset;
}
/** The bridge service. One instance per plugin activation. */
export class Bridge {
    ctx;
    cfg;
    log;
    /** Sessions created through this bridge (approval answering scope). */
    managed = new Set();
    approvals = new Map();
    questions = new Map();
    questionSeq = 0;
    approvalsEnabled = false;
    questionsEnabled = false;
    started = false;
    goalRequests = new RequestIdMap();
    goalStore;
    pollCursors = new PollCursorMap();
    apiProxy;
    muxAbort;
    webOwnsApprovals = false;
    workspaceGuard = new WorkspaceConcurrencyGuard();
    idempotencyManager = new ExecutionIdempotencyManager();
    workspaceBaselines = new Map();
    recordedMutationCalls = new Set();
    recordedExecutionEvidenceCalls = new Set();
    observedSuccessfulMutationCalls = new Set();
    pendingBaselineRefresh = new Set();
    pendingExecutionFingerprints = new Map();
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
    }
    // ── lifecycle ─────────────────────────────────────────────────────────────
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
            // Headless: this process owns the answerer seams.
            this.webOwnsApprovals = false;
            this.approvalsEnabled = true;
            this.questionsEnabled = true;
        }
        this.ctx.on('user-questions/request', async (request, next) => {
            const sessionId = request.agent?.id;
            if (!this.questionsEnabled || sessionId === undefined || !this.managed.has(sessionId)) {
                return next();
            }
            const callId = openAskUserQuestions(request.agent?.session?.snapshotEvents?.() ?? [])[0]?.callId;
            const id = callId ?? `question-${++this.questionSeq}`;
            return new Promise((resolve) => {
                this.questions.set(id, { id, callId, sessionId, questions: request.questions, resolve });
                this.log.info(`question ${id} pending for session ${sessionId}`);
            });
        }, { global: true, prepend: true });
        this.ctx.on('approval/request', (request, next) => this.decideApproval(request, next), { global: true, prepend: true });
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
        return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
    }
    /** Agent-scoped model selection with log-derived fallback for resumes. */
    installSelection(agentCtx, agent) {
        const defaults = this.ctx.get('agentDefaultModel');
        let picked;
        const selection = {
            get current() {
                if (picked !== undefined)
                    return picked;
                const logged = agent.session.requestHeader()?.config;
                if (logged !== undefined) {
                    return {
                        provider: logged.provider,
                        model: logged.model,
                        ...(logged.reasoningEffort !== undefined ? { reasoningEffort: logged.reasoningEffort } : {}),
                    };
                }
                if (defaults !== undefined)
                    return defaults.currentSelection();
                return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
            },
            set current(next) {
                picked = next;
            },
            assembled: undefined,
        };
        installModelSelection(agentCtx, selection);
    }
    /** Compose the preset+selection setup used at agent creation/resume. */
    async composeSetupFor(presetId) {
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined) {
            return {
                setup: (agentCtx, agent) => {
                    this.installSelection(agentCtx, agent);
                },
            };
        }
        const resolvedId = presetId ?? (await presets.resolve(undefined)).id;
        return {
            agentPreset: resolvedId,
            setup: async (agentCtx, agent) => {
                this.installSelection(agentCtx, agent);
                await presets.mount(agentCtx, resolvedId);
            },
        };
    }
    // ── session loading ───────────────────────────────────────────────────────
    async loadView(sessionId) {
        const liveAgent = this.ctx.agents.get(SessionId(sessionId));
        if (liveAgent !== undefined) {
            return { agent: liveAgent, session: liveAgent.session, events: liveAgent.session.snapshotEvents(), header: liveAgent.session.header };
        }
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
            throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
        }
        try {
            const handle = await persistence.open(SessionId(sessionId), 'read');
            try {
                const { events } = await handle.read();
                return { events, header: handle.header };
            }
            finally {
                await handle.close();
            }
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
        let header;
        let events;
        try {
            const handle = await persistence.open(SessionId(sessionId), 'read');
            try {
                header = handle.header;
                events = (await handle.read()).events;
            }
            finally {
                await handle.close();
            }
        }
        catch {
            throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
        }
        const presetId = resolveSessionPreset(header, events);
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
                userQuestions: this.questionsEnabled,
                approvals: this.approvalsEnabled,
                workspaces: workspaces.length,
                webSurface: this.apiProxy !== undefined || this.ctx.get('webRuntime') !== undefined,
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
            const key = pending.callId ?? pending.id;
            seenQuestions.add(key);
            seenQuestions.add(pending.id);
            questions.push({
                question_id: key,
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
            ...this.goalFields(sessionId, view, status),
        };
    }
    async listSessions(options) {
        const persistence = this.ctx.get('sessionPersistence');
        const persisted = persistence === undefined ? [] : await persistence.list();
        const live = this.ctx.sessions.list();
        const byId = new Map();
        for (const snapshot of persisted)
            byId.set(snapshot.header.id, snapshot.header);
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
                    hasPendingInbox: agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0,
                    pendingApprovals: this.waitingFor(header.id, agent.session.snapshotEvents()).approvals.length,
                    pendingQuestions: this.waitingFor(header.id, agent.session.snapshotEvents()).questions.length,
                    events: agent.session.snapshotEvents(),
                });
            out.push({
                session_id: header.id,
                ...(title === undefined ? {} : { title }),
                ...(header.cwd === undefined ? {} : { workspace: header.cwd }),
                ...(status === undefined ? {} : { status }),
                created_at: iso(header.createdAt),
                ...(agent === undefined ? {} : { updated_at: lastEventTime(agent.session.snapshotEvents()) }),
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
            const snapshot = cache.cachedSnapshot(header, SessionLogOffset(0));
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
        this.releaseWorkspaceIfTerminal(sessionId, status);
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
            ...this.goalFields(sessionId, view, status),
        };
    }
    // ── Goal Supervision ──────────────────────────────────────────────────────
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
        const observed = this.observeGoal(sessionId, view, await this.statusOf(sessionId, view));
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
        return this.goalSnapshot(sessionId, view, status, this.now() - started, seconds);
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
                    ...(await this.mapGoalStart(existing.sessionId, view)),
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
                    ...(await this.mapGoalStart(sessionId, view)),
                    existing_goal_reused: true,
                    revision_unchanged: true,
                };
            }
            this.assertMutableWorkspaceAvailable(workspacePath, undefined, lockOverride, isReadOnly);
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
        await this.takeWorkspaceLock(workspacePath, sessionId, lockOverride, isReadOnly);
        // 3. Goal Deduplication on existing session
        if (existingRecord !== undefined &&
            isGoalSemanticallyEqual(existingRecord, input.goal, input.plan, input.execution_mode, input.constraints)) {
            if (input.request_id !== undefined && input.request_id !== '') {
                this.goalRequests.set(input.request_id, { sessionId, fingerprint });
            }
            const view = await this.loadView(sessionId);
            return {
                ...(await this.mapGoalStart(sessionId, view)),
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
        return this.mapGoalStart(sessionId, view);
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
                    ...(await this.mapGoalStart(existing.sessionId, view)),
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
            this.assertMutableWorkspaceAvailable(workspacePath, sessionId, lockOverride, isReadOnly);
            await this.takeWorkspaceLock(workspacePath, sessionId, lockOverride, isReadOnly);
        }
        const observed = this.observeGoal(sessionId, viewBefore, await this.statusOf(sessionId, viewBefore));
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
        return this.mapGoalStart(sessionId, view);
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
        return this.goalSnapshot(sessionId, view, status, this.now() - started, seconds);
    }
    async stopGoal(sessionId) {
        this.adopt(sessionId);
        this.workspaceGuard.releaseLock(sessionId);
        const view = await this.loadView(sessionId);
        const status = await this.statusOf(sessionId, view);
        if (isTerminalStatus(status) || status === 'unknown' || (status === 'idle' && view.agent === undefined)) {
            const warning = this.cleanupGoalTemps(sessionId, view);
            return {
                session_id: sessionId,
                stopped: true,
                already_stopped: true,
                status,
                ...(warning === undefined ? {} : { cleanup_warning: warning }),
            };
        }
        if (status === 'idle' && view.agent !== undefined && !isActiveStatus(status)) {
            const warning = this.cleanupGoalTemps(sessionId, view);
            return {
                session_id: sessionId,
                stopped: true,
                already_stopped: true,
                status,
                ...(warning === undefined ? {} : { cleanup_warning: warning }),
            };
        }
        await this.failClosedWaiting(sessionId);
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (agent !== undefined)
            agent.cancel({ kind: 'user' });
        const warning = this.cleanupGoalTemps(sessionId, view);
        this.noteGoalEvent(sessionId, 'goal_cancelled');
        return {
            session_id: sessionId,
            stopped: true,
            already_stopped: false,
            status: 'cancelled',
            ...(warning === undefined ? {} : { cleanup_warning: warning }),
        };
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
    async mapGoalStart(sessionId, view) {
        const status = await this.statusOf(sessionId, view);
        this.releaseWorkspaceIfTerminal(sessionId, status);
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
    noteGoalEvent(sessionId, type, extra) {
        const record = this.goalStore.get(sessionId);
        if (record === undefined)
            return;
        this.goalStore.put(appendGoalEvent(record, type, { ...extra, now: this.now() }));
    }
    /**
     * Decide a DSH approval/request for a managed session.
     * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
     * deny/reject always remain reachable even if approve is blocked.
     */
    async decideApproval(request, next = () => Promise.resolve('rejected')) {
        if (!this.managed.has(request.agent.id))
            return next();
        const command = commandForCall(request.agent.session?.snapshotEvents?.(), request.callId);
        const workspacePath = request.agent.session?.header?.cwd
            ?? this.workspaceBaselines.get(request.agent.id)?.workspacePath;
        const writeOperation = classesForTool(request.toolName, command).includes('filesystem.write');
        const targetPaths = filePathsForCall(request.agent.session?.snapshotEvents?.(), request.callId);
        const externalWrite = writeOperation && (workspacePath === undefined
            || targetPaths.length === 0
            || targetPaths.some((path) => !isPathInsideWorkspace(path, workspacePath)));
        const evalDecision = evaluateApproval(request.toolName, command, this.approvalPolicy, { externalWrite });
        if (workspacePath !== undefined && workspacePath !== '') {
            this.recordObservedExecutionFacts(request.agent.id, workspacePath, foldGoalFacts((request.agent.session?.snapshotEvents?.() ?? [])));
            await this.refreshWorkspaceBaselineIfNeeded(request.agent.id, workspacePath);
        }
        const baseline = this.workspaceBaselines.get(request.agent.id);
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
            const skip = this.skipIdempotentStep(request.agent.id, request.toolName, command, workspacePath, currentSnapshot ?? baseline, request.callId);
            if (skip !== undefined)
                return 'rejected';
        }
        // A proven no-op replay is safe to fold before the normal constraint
        // rejection path. New work still goes through constraints and approval.
        if (this.rejectConstraint(request))
            return 'rejected';
        if (evalDecision.decision === 'auto_approve') {
            if (workspacePath && mutatingOperation) {
                this.noteMutation(workspacePath, request.agent.id, request.toolName, command, request.callId);
            }
            this.log.info(`auto-approving L0/L1 tool ${request.toolName} (capability ${evalDecision.capability}) for session ${request.agent.id}`);
            return 'approved';
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
        const command = commandForCall(request.agent.session?.snapshotEvents?.(), request.callId);
        const changed = changedFileCountOf(request.agent.session?.snapshotEvents?.());
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
    observeGoal(sessionId, view, status) {
        const facts = foldGoalFacts(view.events);
        this.recordObservedExecutions(sessionId, view, facts);
        let record = this.goalStore.get(sessionId);
        const succeeded = [...successfulKinds(facts)];
        if (record !== undefined && succeeded.some((kind) => !record.completed_action_kinds.includes(kind))) {
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
    goalFields(sessionId, view, status) {
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
    cleanupGoalTemps(sessionId, view) {
        const workspace = view.header.cwd;
        if (typeof workspace !== 'string' || workspace === '')
            return undefined;
        const facts = foldGoalFacts(view.events);
        const record = this.goalStore.get(sessionId);
        const resources = discoverTempResources({
            facts,
            sessionId,
            goalId: record?.goal_id ?? sessionId,
            workspacePath: workspace,
        });
        if (resources.length === 0)
            return undefined;
        const cleaned = cleanupTempResources(resources, workspace);
        if (cleaned.warnings.length === 0)
            return undefined;
        return cleaned.warnings.join('; ');
    }
    async goalSnapshot(sessionId, view, status, waitedMs, waitSeconds) {
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
        this.releaseWorkspaceIfTerminal(sessionId, status);
        if (!mapped.terminal)
            return mapped;
        const warning = this.cleanupGoalTemps(sessionId, view);
        return warning === undefined ? mapped : { ...mapped, cleanup_warning: warning };
    }
    // ── user questions / approvals ────────────────────────────────────────────
    async answerQuestion(questionId, sessionId, answer) {
        const pending = [...this.questions.values()].find((item) => (item.id === questionId || item.callId === questionId) && (sessionId === undefined || item.sessionId === sessionId));
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
        this.questions.delete(pending.id);
        if (pending.callId !== undefined)
            this.questions.delete(pending.callId);
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
            const workspacePath = this.workspaceBaselines.get(sessionId)?.workspacePath;
            if (workspacePath && isMutatingTool(pending.toolName, pending.command)) {
                this.noteMutation(workspacePath, sessionId, pending.toolName, pending.command, pending.callId);
            }
        }
        this.log.info(`approval ${approvalId} decided: ${decision}`);
        this.noteGoalEvent(sessionId, 'approval_resolved', {
            metadata: { approval_id: approvalId, decision, layer: 'user' },
        });
        return { approval_id: approvalId, session_id: sessionId, decision, outcome, layer: 'user' };
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
    // ── introspection used by the MCP layer ───────────────────────────────────
    listManaged() {
        return [...this.managed];
    }
}
function uniqueStrings(values) {
    return [...new Set(values.filter((item) => item.trim() !== ''))];
}
function rememberCappedSet(target, value, cap = 2048) {
    if (target.has(value))
        target.delete(value);
    target.add(value);
    while (target.size > cap) {
        const oldest = target.values().next().value;
        if (oldest === undefined)
            break;
        target.delete(oldest);
    }
}
function isMutatingTool(toolName, command) {
    const classes = classesForTool(toolName, command);
    return classes.includes('filesystem.write')
        || classes.includes('git.mutate')
        || classes.includes('npm.publish')
        || classes.includes('github.release')
        || classes.includes('external_path.write');
}
