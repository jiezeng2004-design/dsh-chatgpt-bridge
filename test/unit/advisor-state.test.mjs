import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from '../../lib/bridge.js';
import { AdvisorStore, advisorStateDir, clampAdvisorWaitMs } from '../../lib/advisor/state.js';

const plan = { rationale: ' Inspect and update the module. ', actions: ['Implement the change'],
  files_likely: ['src/example.ts'], tests: ['Run unit tests'], success_criteria: ['Checks pass'] };
const normalizedPlan = { ...plan, rationale: plan.rationale.trim() };
const execution = { changed_files_count: 1, tests: [{ name: 'unit', status: 'passed' }], summary: ' Completed the scoped change. ' };
const nextSteps = { INIT: 'submit_plan', PLAN: 'get_plan', EXECUTING: 'report_executed',
  EXECUTED: 'submit_verdict', HANDOFF: 'submit_verdict', DONE: 'none', BLOCKED: 'none', ERROR: 'none' };
const code = (expected) => (error) => error instanceof BridgeError && error.code === expected;

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-state-'));
  const stores = [];
  const open = async (extra = {}) => {
    const store = await AdvisorStore.open({ dir, ...options, ...extra });
    stores.push(store);
    return store;
  };
  // The keepalive is test-owned: production long-poll timers must remain unref'ed.
  const keepalive = setInterval(() => {}, 1000);
  t.after(async () => {
    clearInterval(keepalive);
    await Promise.all(stores.map((store) => store.close()));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, open, store: await open() };
}
async function create(store, extra = {}) {
  return store.createTask({ workspace_id: 'workspace', goal: 'Implement a bounded advisor loop', ...extra });
}
async function check(store, task_id, state, iteration, dir) {
  const task = await store.getTask(task_id);
  assert.equal(task.state, state);
  assert.equal(task.iteration, iteration);
  assert.deepEqual(task.checkpoint, { state, iteration, next_step: nextSteps[state] });
  if (dir) assert.deepEqual(JSON.parse(await readFile(join(dir, `${task_id}.json`), 'utf8')), task);
  return task;
}
async function execute(store, task_id, iteration = 1) {
  if (iteration === 1) await store.submitPlan({ task_id, iteration, ...plan });
  await store.getPlan({ task_id, wait_ms: 0 });
  return store.reportExecuted({ task_id, iteration, ...execution });
}

test('advisor state: happy path, durable checkpoints and stable non-destructive requests', async (t) => {
  const { store, dir } = await fixture(t);
  const initial = await create(store, { session_id: ' session-1 ' });
  const id = initial.task_id;
  assert.match(id, /^adv_[0-9a-f]{16}$/);
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.session_id, 'session-1');
  assert.equal(initial.max_iterations, 12);
  await check(store, id, 'INIT', 0, dir);
  const init = await store.waitRequest({ wait_ms: 0 });
  assert.deepEqual(init, { request: { request_id: `${id}:0:INIT`, task_id: id, kind: 'INIT',
    iteration: 0, workspace_id: 'workspace', goal: initial.goal } });
  assert.deepEqual(await store.waitRequest({ task_id: id, wait_ms: 0 }), init);
  await store.submitPlan({ task_id: id, iteration: 1, ...plan });
  await check(store, id, 'PLAN', 1, dir);
  assert.deepEqual(await store.waitRequest({ wait_ms: 0 }), { idle: true });
  assert.deepEqual(await store.getPlan({ task_id: id }), { task_id: id, iteration: 1, plan: normalizedPlan });
  await check(store, id, 'EXECUTING', 1, dir);
  await store.reportExecuted({ task_id: id, iteration: 1, ...execution });
  await check(store, id, 'EXECUTED', 1, dir);
  const executed = await store.waitRequest({ task_id: id });
  assert.deepEqual(executed.request, { request_id: `${id}:1:EXECUTED`, task_id: id, kind: 'EXECUTED',
    iteration: 1, workspace_id: initial.workspace_id, goal: initial.goal,
    last_executed: { ...execution, iteration: 1, summary: execution.summary.trim() } });
  assert.deepEqual(await store.waitRequest({ wait_ms: 0 }), executed);
  const next = await store.submitVerdict({ task_id: id, iteration: 1, verdict: 'plan', reason: 'One more check', plan });
  assert.equal(next.verdict_history[0].verdict, 'plan');
  await check(store, id, 'PLAN', 2, dir);
  await store.getPlan({ task_id: id });
  await check(store, id, 'EXECUTING', 2, dir);
  await store.reportExecuted({ task_id: id, iteration: 2, ...execution });
  await check(store, id, 'EXECUTED', 2, dir);
  assert.equal((await store.waitRequest()).request.request_id, `${id}:2:EXECUTED`);
  await store.submitVerdict({ task_id: id, iteration: 2, verdict: 'done', reason: 'Reviewed' });
  const done = await check(store, id, 'DONE', 2, dir);
  assert.equal(done.verdict_history.length, 2);
  assert.deepEqual(await store.getPlan({ task_id: id }), { task_id: id, state: 'DONE', terminal: true, verdict: 'done' });
  assert.deepEqual(await store.waitRequest({ wait_ms: 0 }), { idle: true });
  assert.deepEqual((await readdir(dir)).sort(), [`${id}.json`]);
});

test('advisor state: restart restores EXECUTED requests and unconsumed PLAN', async (t) => {
  const { store: a, open, dir } = await fixture(t);
  const first = await create(a), second = await create(a);
  await execute(a, first.task_id);
  await a.submitPlan({ task_id: second.task_id, iteration: 1, ...plan });
  const expected = await a.waitRequest({ task_id: first.task_id, wait_ms: 0 });
  await a.close();
  const b = await open();
  assert.deepEqual(await b.waitRequest({ wait_ms: 0 }), expected);
  await check(b, first.task_id, 'EXECUTED', 1, dir);
  assert.deepEqual(await b.getPlan({ task_id: second.task_id, wait_ms: 0 }),
    { task_id: second.task_id, iteration: 1, plan: normalizedPlan });
  await check(b, second.task_id, 'EXECUTING', 1, dir);
});

test('advisor state: iteration limit blocks the requested next plan', async (t) => {
  const { store, dir } = await fixture(t, { maxIterations: 2 });
  const { task_id } = await create(store);
  await execute(store, task_id);
  await store.submitVerdict({ task_id, iteration: 1, verdict: 'plan', plan });
  await execute(store, task_id, 2);
  const result = await store.submitVerdict({ task_id, iteration: 2, verdict: 'plan', plan });
  assert.equal(result.blocked_reason, 'iteration_limit');
  await check(store, task_id, 'BLOCKED', 2, dir);
  assert.deepEqual(await store.getPlan({ task_id }), { task_id, state: 'BLOCKED', terminal: true,
    verdict: 'blocked', blocked_reason: 'iteration_limit' });
});

test('advisor state: concurrent submissions serialize; broadcast requests are not consumed', async (t) => {
  const { store } = await fixture(t);
  const waits = [store.waitRequest({ wait_ms: 200 }), store.waitRequest({ wait_ms: 200 })];
  await delay(10);
  const { task_id } = await create(store);
  const [a, b] = await Promise.all(waits);
  assert.equal(a.request.task_id, task_id);
  assert.deepEqual(a, b);
  const submissions = await Promise.allSettled([1, 2].map(() => store.submitPlan({ task_id, iteration: 1, ...plan })));
  assert.equal(submissions.filter((r) => r.status === 'fulfilled').length, 1);
  const failure = submissions.find((r) => r.status === 'rejected').reason;
  assert.ok(failure instanceof BridgeError);
  assert.ok(['STALE_ITERATION', 'INVALID_STATE'].includes(failure.code));
  const claims = await Promise.all([store.getPlan({ task_id, wait_ms: 50 }), store.getPlan({ task_id, wait_ms: 50 })]);
  assert.equal(claims.filter((r) => r.plan).length, 1);
  assert.equal(claims.filter((r) => r.waiting && r.state === 'EXECUTING').length, 1);
});

test('advisor state: polling timeouts, default/capped waits and PLAN wakeup', async (t) => {
  const { store } = await fixture(t);
  assert.equal(clampAdvisorWaitMs(), 90_000);
  assert.equal(clampAdvisorWaitMs(1_000_000), 100_000);
  assert.equal(clampAdvisorWaitMs(-1), 0);
  assert.equal(clampAdvisorWaitMs(50.9), 50);
  assert.deepEqual(await store.waitRequest({ wait_ms: 50 }), { idle: true });
  const { task_id } = await create(store);
  assert.deepEqual(await store.getPlan({ task_id, wait_ms: 50 }), { task_id, waiting: true, state: 'INIT' });
  const waiting = store.getPlan({ task_id, wait_ms: 200 });
  await delay(10);
  await store.submitPlan({ task_id, iteration: 1, ...plan });
  assert.equal((await waiting).iteration, 1);
  await check(store, task_id, 'EXECUTING', 1);
});

test('advisor state: cleanup expires idle tasks, wakes waiters and deletes retained terminal files', async (t) => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const { store, dir } = await fixture(t, { now: () => now, retentionMs: 1000, idleTtlMs: 100 });
  const done = await create(store), idle = await create(store);
  await execute(store, done.task_id);
  await store.submitVerdict({ task_id: done.task_id, iteration: 1, verdict: 'done' });
  const wait = store.getPlan({ task_id: idle.task_id, wait_ms: 200 });
  await delay(10);
  now += 101;
  await store.cleanup();
  const terminal = await wait;
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.error, 'expired');
  await check(store, idle.task_id, 'ERROR', 0, dir);
  assert.ok((await readdir(dir)).includes(`${done.task_id}.json`));
  now += 1001;
  await store.cleanup();
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(store.getTask(done.task_id), code('TASK_NOT_FOUND'));
  await assert.rejects(store.getTask(idle.task_id), code('TASK_NOT_FOUND'));
});

test('advisor state: load cleans up and opportunistic cleanup runs at most once per minute', async (t) => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const { store, open, dir } = await fixture(t, { now: () => now, idleTtlMs: 100 });
  const { task_id } = await create(store);
  now += 101;
  await check(store, task_id, 'INIT', 0); // No opportunistic sweep inside the minute.
  now += 60_000;
  await check(store, task_id, 'ERROR', 0, dir);
  const pending = await create(store);
  now += 101;
  await store.close();
  const b = await open();
  await check(b, pending.task_id, 'ERROR', 0, dir);
  await b.load(); // Loading twice must not replace live state.
  await check(b, pending.task_id, 'ERROR', 0);
});

test('advisor state: invalid ids are rejected before IO and unknown valid ids are rejected', async (t) => {
  const { store, dir } = await fixture(t);
  await create(store);
  const before = await readdir(dir);
  for (const task_id of ['../x', 'adv_../../x', 'adv_ABCDEF0123456789', ' adv_0123456789abcdef', '', null, 42]) {
    for (const operation of [() => store.getTask(task_id), () => store.getPlan({ task_id, wait_ms: 0 }),
      () => store.waitRequest({ task_id, wait_ms: 0 }), () => store.submitPlan({ task_id, iteration: 1, ...plan }),
      () => store.reportExecuted({ task_id, iteration: 1, ...execution }), () => store.handoff({ task_id, reason: 'Help' }),
      () => store.submitVerdict({ task_id, iteration: 1, verdict: 'done' })]) {
      await assert.rejects(operation(), code('INVALID_TASK_ID'));
    }
  }
  assert.deepEqual(await readdir(dir), before);
  for (const operation of [() => store.getTask('adv_0123456789abcdef'),
    () => store.waitRequest({ task_id: 'adv_0123456789abcdef', wait_ms: 0 }),
    () => store.getPlan({ task_id: 'adv_0123456789abcdef', wait_ms: 0 })]) {
    await assert.rejects(operation(), code('TASK_NOT_FOUND'));
  }
});

test('advisor state: validates all bounded text, arrays, numbers and enum inputs', async (t) => {
  const { store } = await fixture(t);
  const long = 'x'.repeat(2049);
  for (const extra of [{ goal: long }, { goal: ' ' }, { workspace_id: long }, { session_id: '' }]) {
    await assert.rejects(create(store, extra), code('INVALID_ARGUMENT'));
  }
  const { task_id } = await create(store, { goal: 'x'.repeat(2048) });
  for (const extra of [{ rationale: long }, { actions: Array(51).fill('x') }, { files_likely: [long] },
    { tests: [' '] }, { success_criteria: null }, { iteration: -1 }, { iteration: 1.2 }]) {
    await assert.rejects(store.submitPlan({ task_id, iteration: 1, ...plan, ...extra }), code('INVALID_ARGUMENT'));
  }
  await store.submitPlan({ task_id, iteration: 1, ...plan });
  for (const reason of ['', ' ', long, 5]) await assert.rejects(store.handoff({ task_id, reason }), code('INVALID_ARGUMENT'));
  await store.getPlan({ task_id });
  for (const extra of [{ changed_files_count: -1 }, { changed_files_count: 1.2 }, { summary: long },
    { tests: Array(51).fill({ name: 'unit', status: 'passed' }) }, { tests: [{ name: long, status: 'passed' }] },
    { tests: [{ name: 'unit', status: 'unknown' }] }, { tests: [null] }]) {
    await assert.rejects(store.reportExecuted({ task_id, iteration: 1, ...execution, ...extra }), code('INVALID_ARGUMENT'));
  }
  await store.reportExecuted({ task_id, iteration: 1, ...execution,
    tests: ['passed', 'failed', 'skipped', 'not_run'].map((status) => ({ name: status, status })) });
  for (const extra of [{ verdict: 'blocked' }, { verdict: 'blocked', reason: ' ' }, { verdict: 'plan' },
    { verdict: 'plan', plan: {} }, { verdict: 'unknown' }, { reason: long }, { iteration: NaN }]) {
    await assert.rejects(store.submitVerdict({ task_id, iteration: 1, verdict: 'done', ...extra }), code('INVALID_ARGUMENT'));
  }
  await assert.rejects(store.listTasks({ workspace_id: ' ' }), code('INVALID_ARGUMENT'));
  await assert.rejects(store.listTasks({ include_terminal: 'yes' }), code('INVALID_ARGUMENT'));
  await assert.rejects(store.waitRequest({ wait_ms: Infinity }), code('INVALID_ARGUMENT'));
  await assert.rejects(store.getPlan({ task_id, wait_ms: '100' }), code('INVALID_ARGUMENT'));
  await assert.rejects(store.createTask(null), code('INVALID_ARGUMENT'));
  for (const options of [{ maxIterations: NaN }, { maxIterations: null }, { retentionMs: -1 }, { retentionMs: null }, { idleTtlMs: Infinity },
    { now: 1 }, { logger: {} }, { dir: '' }]) assert.throws(() => new AdvisorStore(options), code('INVALID_ARGUMENT'));
});

test('advisor state: state and stale iteration errors preserve the task', async (t) => {
  const { store } = await fixture(t);
  const { task_id } = await create(store);
  await assert.rejects(store.reportExecuted({ task_id, iteration: 1, ...execution }), (e) => code('INVALID_STATE')(e) && e.message.includes('INIT'));
  await assert.rejects(store.handoff({ task_id, reason: 'Help' }), code('INVALID_STATE'));
  await assert.rejects(store.submitVerdict({ task_id, iteration: 0, verdict: 'done' }), code('INVALID_STATE'));
  await assert.rejects(store.submitPlan({ task_id, iteration: 2, ...plan }), code('STALE_ITERATION'));
  await store.submitPlan({ task_id, iteration: 1, ...plan });
  await assert.rejects(store.submitPlan({ task_id, iteration: 1, ...plan }), code('INVALID_STATE'));
  await assert.rejects(store.reportExecuted({ task_id, iteration: 1, ...execution }), code('INVALID_STATE'));
  await store.getPlan({ task_id });
  await assert.rejects(store.reportExecuted({ task_id, iteration: 2, ...execution }), code('STALE_ITERATION'));
  await store.reportExecuted({ task_id, iteration: 1, ...execution });
  await assert.rejects(store.submitVerdict({ task_id, iteration: 0, verdict: 'done' }), code('STALE_ITERATION'));
  await check(store, task_id, 'EXECUTED', 1);
  await store.submitVerdict({ task_id, iteration: 1, verdict: 'blocked', reason: ' Need a decision ' });
  const blocked = await check(store, task_id, 'BLOCKED', 1);
  assert.equal(blocked.blocked_reason, 'Need a decision');
  await assert.rejects(store.handoff({ task_id, reason: 'Help' }), code('INVALID_STATE'));
});

test('advisor state: malformed, unknown-schema, mismatched and inconsistent files are skipped', async (t) => {
  const warnings = [];
  const { store, dir, open } = await fixture(t);
  const valid = await create(store);
  const files = {
    'adv_0000000000000001.json': '{invalid json',
    'adv_0000000000000002.json': JSON.stringify({ ...valid, schemaVersion: 99, task_id: 'adv_0000000000000002' }),
    'adv_0000000000000003.json': JSON.stringify({ ...valid, task_id: 'adv_0000000000000003', checkpoint: {} }),
    'adv_0000000000000004.json': JSON.stringify({ ...valid, task_id: 'adv_0000000000000004', goal: 'x'.repeat(2049) }),
    'adv_0000000000000005.json': JSON.stringify(valid),
    'adv_not-a-task.json': 'ignored',
    'other.json': 'ignored',
  };
  for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents);
  await mkdir(join(dir, 'adv_0000000000000006.json')); // Do not traverse directories masquerading as records.
  await store.close();
  const recovered = await open({ logger: { warn: (msg) => warnings.push(msg) } });
  assert.deepEqual((await recovered.listTasks()).map((t) => t.task_id), [valid.task_id]);
  assert.equal(warnings.length, 5);
  assert.ok(warnings.every((msg) => msg.includes('Skipped invalid advisor task') && !msg.includes(valid.goal)));
  assert.equal(await readFile(join(dir, 'adv_0000000000000001.json'), 'utf8'), '{invalid json');
});

test('advisor state: close promptly resolves every waiter and rejects subsequent mutations', async (t) => {
  const { store } = await fixture(t);
  const { task_id } = await create(store);
  await store.submitPlan({ task_id, iteration: 1, ...plan });
  await store.getPlan({ task_id });
  const waits = [store.waitRequest({ wait_ms: 100_000 }), store.waitRequest({ task_id, wait_ms: 100_000 }),
    store.getPlan({ task_id, wait_ms: 100_000 })];
  await delay(10);
  await store.close();
  const result = await Promise.race([Promise.all(waits), delay(200).then(() => 'timeout')]);
  assert.deepEqual(result, [{ idle: true }, { idle: true }, { task_id, waiting: true, state: 'EXECUTING' }]);
  await assert.rejects(store.handoff({ task_id, reason: 'Help' }), code('STORE_CLOSED'));
  assert.deepEqual(await store.waitRequest(), { idle: true });
  await store.close();
});

test('advisor state: HANDOFF from all three allowed states persists and exits through every verdict', async (t) => {
  const { store, open, dir } = await fixture(t);
  for (const [from, verdict] of [['PLAN', 'plan'], ['EXECUTING', 'blocked'], ['EXECUTED', 'done']]) {
    const { task_id } = await create(store);
    await store.submitPlan({ task_id, iteration: 1, ...plan });
    if (from !== 'PLAN') await store.getPlan({ task_id });
    if (from === 'EXECUTED') await store.reportExecuted({ task_id, iteration: 1, ...execution });
    await store.handoff({ task_id, reason: ` Attention from ${from} ` });
    await check(store, task_id, 'HANDOFF', 1, dir);
    const request = (await store.waitRequest({ task_id })).request;
    assert.equal(request.kind, 'HANDOFF');
    assert.equal(request.request_id, `${task_id}:1:HANDOFF`);
    assert.equal(request.handoff_reason, `Attention from ${from}`);
    assert.equal(!!request.last_executed, from === 'EXECUTED');
    const reopened = await open();
    assert.deepEqual(await reopened.waitRequest({ task_id, wait_ms: 0 }), { request });
    await reopened.close();
    const result = await store.submitVerdict({ task_id, iteration: 1, verdict, reason: 'Reviewed', ...(verdict === 'plan' ? { plan } : {}) });
    assert.equal(result.handoff_reason, undefined);
    await check(store, task_id, verdict === 'plan' ? 'PLAN' : verdict === 'done' ? 'DONE' : 'BLOCKED', verdict === 'plan' ? 2 : 1, dir);
  }
});

test('advisor state: close during poll initialization also returns idle/waiting', async () => {
  // Exercise every microtask boundary between entry, initialization and subscription.
  for (let turns = 0; turns < 8; turns++) {
    const store = await AdvisorStore.open();
    try {
      const { task_id } = await create(store);
      const waiting = store.getPlan({ task_id, wait_ms: 100_000 });
      const request = store.waitRequest({ task_id, wait_ms: 100_000 });
      for (let i = 0; i < turns; i++) await Promise.resolve();
      await store.close();
      assert.deepEqual(await waiting, { task_id, waiting: true, state: 'INIT' });
      const result = await request;
      assert.ok(result.idle || result.request?.task_id === task_id);
    } finally { await store.close(); }
  }
});

test('advisor state: oldest pending request and task-specific wakeups', async (t) => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const { store } = await fixture(t, { now: () => now });
  const first = await create(store);
  now += 1;
  const second = await create(store);
  assert.equal((await store.waitRequest({ wait_ms: 0 })).request.task_id, first.task_id);
  await store.submitPlan({ task_id: first.task_id, iteration: 1, ...plan });
  const filtered = store.waitRequest({ task_id: first.task_id, wait_ms: 200 });
  now += 1;
  await store.handoff({ task_id: first.task_id, reason: 'Please review' });
  assert.equal((await filtered).request.kind, 'HANDOFF');
  assert.equal((await store.waitRequest({ wait_ms: 0 })).request.task_id, second.task_id);
});

test('advisor state: detached snapshots, bounded history, list filtering/order/cap and memory-only mode', async (t) => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new AdvisorStore({ maxIterations: 100, now: () => now });
  t.after(() => store.close());
  const task = await create(store);
  assert.equal(task.max_iterations, 50);
  assert.equal(advisorStateDir('/example'), join('/example', 'chatgpt-bridge', 'advisor'));
  task.goal = 'Changed by caller';
  assert.notEqual((await store.getTask(task.task_id)).goal, task.goal);
  await execute(store, task.task_id);
  for (let iteration = 1; iteration <= 22; iteration++) {
    const result = await store.submitVerdict({ task_id: task.task_id, iteration, verdict: 'plan', plan });
    result.plan.actions[0] = 'Mutated';
    assert.equal((await store.getTask(task.task_id)).plan.actions[0], plan.actions[0]);
    await execute(store, task.task_id, iteration + 1);
  }
  const request = await store.waitRequest({ task_id: task.task_id });
  request.request.last_executed.tests[0].name = 'Mutated';
  assert.equal((await store.getTask(task.task_id)).last_executed.tests[0].name, 'unit');
  await store.submitVerdict({ task_id: task.task_id, iteration: 23, verdict: 'done' });
  const history = (await store.getTask(task.task_id)).verdict_history;
  assert.equal(history.length, 20);
  assert.equal(history[0].iteration, 4);
  assert.deepEqual(await store.listTasks(), []);
  assert.equal((await store.listTasks({ include_terminal: true })).length, 1);
  const ids = [];
  for (let i = 0; i < 105; i++) { now++; ids.push((await create(store, { workspace_id: 'second' })).task_id); }
  const listed = await store.listTasks({ workspace_id: 'second' });
  assert.equal(listed.length, 100);
  assert.deepEqual(listed.map((row) => row.task_id), ids.reverse().slice(0, 100));
  listed[0].goal = 'Mutated';
  assert.notEqual((await store.getTask(listed[0].task_id)).goal, 'Mutated');
  const clamped = await AdvisorStore.open({ maxIterations: 0 });
  t.after(() => clamped.close());
  assert.equal((await create(clamped)).max_iterations, 1);
});

test('advisor state: persistence failure does not publish a transition or leave temp files', async (t) => {
  const { store, dir } = await fixture(t);
  const { task_id } = await create(store);
  const target = join(dir, `${task_id}.json`);
  await rm(target);
  await mkdir(target); // Force rename to fail without subprocesses or production IO hooks.
  await assert.rejects(store.submitPlan({ task_id, iteration: 1, ...plan }), code('STATE_IO_ERROR'));
  await check(store, task_id, 'INIT', 0);
  assert.equal((await store.waitRequest({ wait_ms: 0 })).request.kind, 'INIT');
  assert.deepEqual(await readdir(dir), [`${task_id}.json`]);
  await rm(target, { recursive: true });
  await store.submitPlan({ task_id, iteration: 1, ...plan }); // Failed writes must not poison the task mutex.
  await check(store, task_id, 'PLAN', 1, dir);
});
