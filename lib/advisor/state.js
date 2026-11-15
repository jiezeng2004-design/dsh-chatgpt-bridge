import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError } from '../bridge.js';
const TASK_ID = /^adv_[0-9a-f]{16}$/;
const STATES = ['INIT', 'PLAN', 'EXECUTING', 'EXECUTED', 'HANDOFF', 'DONE', 'BLOCKED', 'ERROR'];
const TERMINAL = new Set(['DONE', 'BLOCKED', 'ERROR']);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
function fail(code, message) { throw new BridgeError(code, message); }
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('INVALID_ARGUMENT', 'Expected an object.');
    return value;
}
function string(value, field) {
    if (typeof value !== 'string' || value.length > 2048 || !value.trim()) {
        fail('INVALID_ARGUMENT', `${field} must be a nonempty string of at most 2048 characters.`);
    }
    return value.trim();
}
function taskId(value) {
    if (typeof value !== 'string' || !TASK_ID.test(value))
        fail('INVALID_TASK_ID', 'Invalid advisor task_id.');
    return value;
}
function integer(value, field, min = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        fail('INVALID_ARGUMENT', `${field} must be a safe integer >= ${min}.`);
    }
    return value;
}
function finite(value, field) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        fail('INVALID_ARGUMENT', `${field} must be finite.`);
    return value;
}
function array(value, field, limit = 50) {
    if (!Array.isArray(value) || value.length > limit)
        fail('INVALID_ARGUMENT', `${field} must be an array of at most ${limit} items.`);
    return value;
}
function planOf(value) {
    const p = object(value);
    const strings = (field) => array(p[field], field).map((item) => string(item, field));
    return { rationale: string(p.rationale, 'rationale'), actions: strings('actions'),
        files_likely: strings('files_likely'), tests: strings('tests'), success_criteria: strings('success_criteria') };
}
function executedOf(value) {
    const e = object(value);
    return { iteration: integer(e.iteration, 'iteration', 1), changed_files_count: integer(e.changed_files_count, 'changed_files_count'),
        tests: array(e.tests, 'tests').map((item) => {
            const test = object(item);
            if (!['passed', 'failed', 'skipped', 'not_run'].includes(test.status))
                fail('INVALID_ARGUMENT', 'Invalid test status.');
            return { name: string(test.name, 'test name'), status: test.status };
        }), summary: string(e.summary, 'summary') };
}
function verdictOf(value) {
    if (!['done', 'blocked', 'plan'].includes(value))
        fail('INVALID_ARGUMENT', 'Invalid verdict.');
    return value;
}
function checkpoint(state, iteration) {
    const next = { INIT: 'submit_plan', PLAN: 'get_plan', EXECUTING: 'report_executed', EXECUTED: 'submit_verdict',
        HANDOFF: 'submit_verdict', DONE: 'none', BLOCKED: 'none', ERROR: 'none' };
    return { state, iteration, next_step: next[state] };
}
function iso(value) {
    const text = string(value, 'timestamp');
    if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text)
        fail('INVALID_ARGUMENT', 'Invalid ISO timestamp.');
    return text;
}
function recordOf(value, id) {
    const r = object(value);
    if (r.schemaVersion !== 1)
        fail('INVALID_ARGUMENT', 'Unknown advisor schemaVersion.');
    if (taskId(r.task_id) !== id)
        fail('INVALID_ARGUMENT', 'Mismatched task_id.');
    if (!STATES.includes(r.state))
        fail('INVALID_ARGUMENT', 'Invalid task state.');
    const state = r.state;
    const iteration = integer(r.iteration, 'iteration');
    const max = integer(r.max_iterations, 'max_iterations', 1);
    if (max > 50 || iteration > max || (state === 'INIT' ? iteration !== 0 : state !== 'ERROR' && iteration === 0)) {
        fail('INVALID_ARGUMENT', 'Invalid persisted iteration.');
    }
    const task = {
        schemaVersion: 1, task_id: id, workspace_id: string(r.workspace_id, 'workspace_id'), goal: string(r.goal, 'goal'),
        state, iteration, max_iterations: max, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
        checkpoint: checkpoint(state, iteration), verdict_history: array(r.verdict_history, 'verdict_history', 20).map((item) => {
            const h = object(item);
            const entry = { iteration: integer(h.iteration, 'history iteration', 1),
                verdict: verdictOf(h.verdict), created_at: iso(h.created_at) };
            if (entry.iteration > iteration)
                fail('INVALID_ARGUMENT', 'Invalid history iteration.');
            if (h.reason !== undefined)
                entry.reason = string(h.reason, 'reason');
            return entry;
        }),
    };
    for (const field of ['session_id', 'handoff_reason', 'blocked_reason', 'error']) {
        if (r[field] !== undefined)
            task[field] = string(r[field], field);
    }
    if (r.plan !== undefined)
        task.plan = planOf(r.plan);
    if (r.last_executed !== undefined)
        task.last_executed = executedOf(r.last_executed);
    const cp = object(r.checkpoint);
    if (cp.state !== state || cp.iteration !== iteration || cp.next_step !== task.checkpoint.next_step
        || (iteration > 0 && !task.plan) || (task.last_executed && task.last_executed.iteration > iteration)
        || (state === 'EXECUTED' && task.last_executed?.iteration !== iteration)
        || (state === 'HANDOFF' && !task.handoff_reason) || (state === 'BLOCKED' && !task.blocked_reason)
        || (state === 'ERROR' && !task.error))
        fail('INVALID_ARGUMENT', 'Inconsistent persisted task.');
    return task;
}
export function clampAdvisorWaitMs(value = 90_000) {
    return Math.min(100_000, Math.max(0, Math.trunc(finite(value, 'wait_ms'))));
}
export function advisorStateDir(dshHome) {
    return join(string(dshHome, 'dshHome'), 'chatgpt-bridge', 'advisor');
}
/**
 * Control metadata only: never put file contents, diffs or logs here. Text fields
 * are bounded to 2048 characters; code and evidence belong in the read-only data plane.
 * Each instance owns its directory (no cross-process writer coordination).
 */
export class AdvisorStore {
    tasks = new Map();
    chains = new Map();
    waiters = new Set();
    dir;
    maxIterations;
    now;
    retentionMs;
    idleTtlMs;
    logger;
    ready;
    maintenance;
    lastCleanup = -Infinity;
    version = 0;
    closed = false;
    constructor(options = {}) {
        object(options);
        this.dir = options.dir === undefined ? undefined : string(options.dir, 'dir');
        this.maxIterations = Math.min(50, Math.max(1, Math.trunc(finite(options.maxIterations === undefined ? 12 : options.maxIterations, 'maxIterations'))));
        this.retentionMs = finite(options.retentionMs === undefined ? 7 * DAY : options.retentionMs, 'retentionMs');
        this.idleTtlMs = finite(options.idleTtlMs === undefined ? DAY : options.idleTtlMs, 'idleTtlMs');
        if (this.retentionMs < 0 || this.idleTtlMs < 0)
            fail('INVALID_ARGUMENT', 'TTLs must be nonnegative.');
        if (options.now !== undefined && typeof options.now !== 'function')
            fail('INVALID_ARGUMENT', 'now must be a function.');
        if (options.logger !== undefined && typeof options.logger?.warn !== 'function')
            fail('INVALID_ARGUMENT', 'logger.warn must be a function.');
        this.now = options.now ?? Date.now;
        this.logger = options.logger;
        this.ready = this.readTasks().then(() => this.runCleanup());
        // A constructor cannot await IO. open()/load() and every operation observe this rejection.
        void this.ready.catch(() => { });
    }
    static async open(options = {}) {
        const store = new AdvisorStore(options);
        await store.load();
        return store;
    }
    /** Idempotent initialization barrier; does not reload over live in-memory transitions. */
    async load() { await this.ready; }
    time() {
        const time = finite(this.now(), 'now');
        if (!Number.isFinite(new Date(time).getTime()))
            fail('INVALID_ARGUMENT', 'now is outside the date range.');
        return time;
    }
    async readTasks() {
        if (!this.dir)
            return;
        let entries;
        try {
            entries = await readdir(this.dir, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            fail('STATE_IO_ERROR', 'Advisor state directory could not be read.');
        }
        for (const entry of entries) {
            if (!entry.isFile() || !/^adv_[0-9a-f]{16}\.json$/.test(entry.name))
                continue;
            const id = taskId(entry.name.slice(0, -5));
            try {
                const task = recordOf(JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')), id);
                this.tasks.set(id, task);
            }
            catch {
                // Do not log payloads, paths, or parser errors, which may contain private data.
                this.logger?.warn(`Skipped invalid advisor task ${id} (malformed record or unsupported schema).`);
            }
        }
    }
    serial(id, action) {
        const prior = this.chains.get(id) ?? Promise.resolve();
        const current = prior.catch(() => { }).then(action);
        this.chains.set(id, current);
        void current.finally(() => { if (this.chains.get(id) === current)
            this.chains.delete(id); }).catch(() => { });
        return current;
    }
    async prepare() {
        await this.ready;
        if (this.closed)
            fail('STORE_CLOSED', 'Advisor store is closed.');
        if (this.maintenance)
            await this.maintenance;
        else if (this.time() - this.lastCleanup >= MINUTE)
            await this.runCleanup();
    }
    get(id) {
        const task = this.tasks.get(id);
        if (!task)
            fail('TASK_NOT_FOUND', 'Advisor task not found.');
        return task;
    }
    state(task, allowed) {
        if (!allowed.includes(task.state))
            fail('INVALID_STATE', `Operation is invalid in state ${task.state}.`);
    }
    iteration(task, expected) {
        if (task.iteration !== expected)
            fail('STALE_ITERATION', `Current iteration is ${task.iteration}.`);
    }
    signal(id) {
        this.version++;
        for (const waiter of this.waiters)
            if (!id || !waiter.task_id || waiter.task_id === id)
                waiter.wake();
    }
    async persist(task) {
        const id = taskId(task.task_id); // Validate before any filesystem path construction.
        if (!this.dir)
            return;
        const temp = join(this.dir, `${id}.${randomBytes(8).toString('hex')}.tmp`);
        try {
            await mkdir(this.dir, { recursive: true });
            await writeFile(temp, JSON.stringify(task), { encoding: 'utf8', flag: 'wx' });
            await rename(temp, join(this.dir, `${id}.json`));
        }
        catch {
            fail('STATE_IO_ERROR', 'Advisor task could not be persisted.');
        }
        finally {
            await rm(temp, { force: true }).catch(() => { });
        }
    }
    async save(task) {
        task.updated_at = new Date(this.time()).toISOString();
        task.checkpoint = checkpoint(task.state, task.iteration);
        await this.persist(task);
        this.tasks.set(task.task_id, task);
        this.signal(task.task_id);
        return structuredClone(task);
    }
    async mutate(id, change) {
        await this.prepare();
        return this.serial(id, async () => {
            if (this.closed)
                fail('STORE_CLOSED', 'Advisor store is closed.');
            const task = structuredClone(this.get(id));
            change(task);
            return this.save(task);
        });
    }
    async createTask(input) {
        const i = object(input);
        const workspace_id = string(i.workspace_id, 'workspace_id');
        const goal = string(i.goal, 'goal');
        const session_id = i.session_id === undefined ? undefined : string(i.session_id, 'session_id');
        await this.prepare();
        let id;
        do {
            id = `adv_${randomBytes(8).toString('hex')}`;
        } while (this.tasks.has(id));
        const at = new Date(this.time()).toISOString();
        return this.save({ schemaVersion: 1, task_id: id, workspace_id, goal,
            ...(session_id === undefined ? {} : { session_id }), state: 'INIT', iteration: 0,
            max_iterations: this.maxIterations, verdict_history: [], created_at: at, updated_at: at, checkpoint: checkpoint('INIT', 0) });
    }
    async submitPlan(input) {
        const i = object(input), id = taskId(i.task_id), iteration = integer(i.iteration, 'iteration', 1), plan = planOf(i);
        return this.mutate(id, (task) => {
            this.state(task, ['INIT']);
            this.iteration(task, iteration - 1);
            task.plan = plan;
            task.iteration = iteration;
            task.state = 'PLAN';
        });
    }
    async reportExecuted(input) {
        const i = object(input), id = taskId(i.task_id), executed = executedOf(i);
        return this.mutate(id, (task) => {
            this.state(task, ['EXECUTING']);
            this.iteration(task, executed.iteration);
            task.last_executed = executed;
            task.state = 'EXECUTED';
        });
    }
    async handoff(input) {
        const i = object(input), id = taskId(i.task_id), reason = string(i.reason, 'reason');
        return this.mutate(id, (task) => {
            this.state(task, ['PLAN', 'EXECUTING', 'EXECUTED']);
            task.state = 'HANDOFF';
            task.handoff_reason = reason;
        });
    }
    async submitVerdict(input) {
        const i = object(input), id = taskId(i.task_id), iteration = integer(i.iteration, 'iteration'), verdict = verdictOf(i.verdict);
        const reason = i.reason === undefined ? undefined : string(i.reason, 'reason');
        const plan = i.plan === undefined ? undefined : planOf(i.plan);
        if (verdict === 'blocked' && !reason)
            fail('INVALID_ARGUMENT', 'Blocked verdict requires reason.');
        if (verdict === 'plan' && !plan)
            fail('INVALID_ARGUMENT', 'Plan verdict requires plan.');
        return this.mutate(id, (task) => {
            this.state(task, ['EXECUTED', 'HANDOFF']);
            this.iteration(task, iteration);
            task.verdict_history = [...task.verdict_history, { iteration, verdict,
                    ...(reason === undefined ? {} : { reason }), created_at: new Date(this.time()).toISOString() }].slice(-20);
            delete task.handoff_reason;
            if (verdict === 'done')
                task.state = 'DONE';
            else if (verdict === 'blocked' || task.iteration >= task.max_iterations) {
                task.state = 'BLOCKED';
                task.blocked_reason = verdict === 'blocked' ? reason : 'iteration_limit';
            }
            else {
                task.state = 'PLAN';
                task.iteration++;
                task.plan = plan;
            }
        });
    }
    async getTask(id) {
        taskId(id);
        await this.prepare();
        return structuredClone(this.get(id));
    }
    async listTasks(input = {}) {
        const i = object(input);
        const workspace = i.workspace_id === undefined ? undefined : string(i.workspace_id, 'workspace_id');
        if (i.include_terminal !== undefined && typeof i.include_terminal !== 'boolean')
            fail('INVALID_ARGUMENT', 'include_terminal must be boolean.');
        await this.prepare();
        return structuredClone([...this.tasks.values()]
            .filter((task) => (workspace === undefined || task.workspace_id === workspace) && (i.include_terminal || !TERMINAL.has(task.state)))
            .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.task_id.localeCompare(a.task_id)).slice(0, 100));
    }
    pending(id) {
        if (id)
            this.get(id);
        const task = [...this.tasks.values()].filter((t) => (!id || t.task_id === id)
            && ['INIT', 'EXECUTED', 'HANDOFF'].includes(t.state))
            .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id))[0];
        if (!task)
            return;
        return { request: structuredClone({ request_id: `${task.task_id}:${task.iteration}:${task.state}`,
                task_id: task.task_id, kind: task.state, iteration: task.iteration,
                workspace_id: task.workspace_id, goal: task.goal,
                ...(task.last_executed === undefined ? {} : { last_executed: task.last_executed }),
                ...(task.handoff_reason === undefined ? {} : { handoff_reason: task.handoff_reason }) }) };
    }
    async poll(id, wait, attempt, fallback) {
        await this.ready;
        if (this.closed)
            return fallback();
        try {
            await this.prepare();
        }
        catch (error) {
            // close() can run while prepare() is awaiting its initialization barrier.
            if (this.closed && error instanceof BridgeError && error.code === 'STORE_CLOSED')
                return fallback();
            throw error;
        }
        const deadline = Date.now() + wait; // Injected now() controls retention, not real poll duration.
        for (;;) {
            const version = this.version;
            if (this.closed)
                return fallback();
            const result = await attempt();
            if (result !== undefined)
                return result;
            const remaining = deadline - Date.now();
            if (this.closed || remaining <= 0)
                return fallback();
            await new Promise((resolve) => {
                const waiter = { task_id: id, wake: () => { clearTimeout(timer); this.waiters.delete(waiter); resolve(); } };
                const timer = setTimeout(waiter.wake, remaining);
                timer.unref();
                this.waiters.add(waiter);
                // A transition may have completed during the awaited attempt, before subscription.
                if (this.closed || version !== this.version)
                    waiter.wake();
            });
        }
    }
    async waitRequest(input = {}) {
        const i = object(input), id = i.task_id === undefined ? undefined : taskId(i.task_id), wait = clampAdvisorWaitMs(i.wait_ms);
        return this.poll(id, wait, async () => this.pending(id), () => ({ idle: true }));
    }
    async getPlan(input) {
        const i = object(input), id = taskId(i.task_id), wait = clampAdvisorWaitMs(i.wait_ms);
        return this.poll(id, wait, () => this.serial(id, async () => {
            const task = this.get(id);
            if (this.closed)
                return undefined;
            if (TERMINAL.has(task.state))
                return { task_id: id, state: task.state, terminal: true,
                    ...(task.state === 'DONE' ? { verdict: 'done' } : task.state === 'BLOCKED' ? { verdict: 'blocked' } : {}),
                    ...(task.blocked_reason === undefined ? {} : { blocked_reason: task.blocked_reason }),
                    ...(task.error === undefined ? {} : { error: task.error }) };
            // Re-delivery: the PLAN -> EXECUTING transition is persisted before the
            // response reaches the executor. If that response is lost (dropped call,
            // DSH restart), the owner must still be able to fetch its instructions,
            // so a task already EXECUTING returns the same plan again. Ownership is
            // enforced by the agent-tool layer (TASK_NOT_OWNED).
            if (task.state === 'EXECUTING' && task.plan) {
                return { task_id: id, iteration: task.iteration, plan: structuredClone(task.plan), redelivered: true };
            }
            if (task.state !== 'PLAN')
                return undefined;
            const next = structuredClone(task);
            next.state = 'EXECUTING';
            const saved = await this.save(next);
            return { task_id: id, iteration: saved.iteration, plan: saved.plan };
        }), () => ({ task_id: id, waiting: true, state: this.get(id).state }));
    }
    runCleanup() {
        if (this.maintenance)
            return this.maintenance;
        const run = async () => {
            const now = this.time();
            this.lastCleanup = now;
            for (const id of this.tasks.keys())
                await this.serial(id, async () => {
                    const task = this.tasks.get(id);
                    if (!task)
                        return;
                    const age = now - Date.parse(task.updated_at);
                    if (TERMINAL.has(task.state)) {
                        if (age <= this.retentionMs)
                            return;
                        if (this.dir) {
                            try {
                                await rm(join(this.dir, `${taskId(id)}.json`), { force: true });
                            }
                            catch {
                                fail('STATE_IO_ERROR', 'Expired advisor task could not be removed.');
                            }
                        }
                        this.tasks.delete(id);
                        this.signal(id);
                    }
                    else if (age > this.idleTtlMs) {
                        await this.save({ ...structuredClone(task), state: 'ERROR', error: 'expired' });
                    }
                });
        };
        this.maintenance = run().finally(() => { this.maintenance = undefined; });
        return this.maintenance;
    }
    async cleanup() {
        await this.ready;
        if (this.closed)
            fail('STORE_CLOSED', 'Advisor store is closed.');
        await this.runCleanup();
    }
    async close() {
        this.closed = true;
        this.signal(); // Clears all waiter timers synchronously, before awaiting any IO.
        await this.ready;
        await Promise.allSettled([...this.chains.values()]);
    }
}
