import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { join } from 'node:path';
import { registerAdvisorAgentTools } from '../../lib/advisor/agent-tools.js';
import { createAdvisorRuntime } from '../../lib/advisor/runtime.js';
import { BridgeError } from '../../lib/bridge.js';
import { resolveConfig } from '../../lib/config.js';
import { inject as requiredInjections } from '../../lib/index.js';

const workspace = { id: 'registered', title: 'Example workspace', path: process.cwd() };
const plan = { rationale: 'Check the requested behavior.', actions: ['Implement the change.'],
  files_likely: ['example.ts'], tests: ['unit'], success_criteria: ['Tests pass.'] };
const executed = { iteration: 1, changed_files_count: 1, tests: [{ name: 'unit', status: 'passed' }], summary: 'Implemented and tested.' };

function agent(id = 'agent-one', cwd = workspace.path) {
  // Use the actual Session implementation to exercise the supported header accessor.
  return { id, session: Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: Date.now(), isSeeded: false, cwd,
  }) };
}

async function setup(t, mode = 'advisor', options = {}) {
  const tools = new Map();
  const providers = [];
  const injections = [];
  const pending = [];
  const disposers = [];
  const warnings = [];
  const log = { debug() {}, info() {}, warn(message) { warnings.push(message); }, error() {} };
  const cfg = resolveConfig({ authMode: 'none', mode }, {});
  const runtime = mode === 'advisor' ? createAdvisorRuntime(cfg, log, { dir: null }) : undefined;
  const ctx = {
    inject(deps, callback) {
      injections.push(deps);
      if (options.unavailable?.some((name) => deps.includes(name))) return;
      pending.push(Promise.resolve(callback({
        tools: { register(def) {
          assert.ok(!tools.has(def.name));
          tools.set(def.name, def);
          return () => tools.delete(def.name);
        } },
        skills: { registerProvider(factory) {
          const provider = factory();
          providers.push(provider);
          return () => providers.splice(providers.indexOf(provider), 1);
        } },
      })).then((dispose) => { if (typeof dispose === 'function') disposers.push(dispose); }));
    },
  };
  const bridge = {
    async listWorkspaces() { return [workspace]; },
    async resolveWorkspace(value) {
      if ([workspace.id, workspace.title, workspace.path].includes(value)) return workspace;
      throw new BridgeError('WORKSPACE_NOT_FOUND', 'No registered workspace matches the reference.');
    },
  };
  registerAdvisorAgentTools(ctx, runtime, bridge, log);
  await Promise.all(pending);
  t.after(async () => {
    for (const dispose of disposers) dispose();
    await runtime?.close();
  });
  const call = (name, args, caller = agent()) => tools.get(name).execute(args, { agent: caller });
  return { tools, providers, injections, disposers, warnings, runtime, call };
}

test('advisor agent tools: exactly four optional tools and a bundled skill, with working disposers', async (t) => {
  const { tools, providers, injections, disposers, warnings } = await setup(t);
  assert.deepEqual([...tools.keys()], ['advisor_init', 'advisor_get_plan', 'advisor_executed', 'advisor_handoff']);
  assert.deepEqual(injections, [['tools'], ['skills']]);
  assert.ok(!requiredInjections.includes('tools'));
  assert.ok(!requiredInjections.includes('skills'));
  assert.ok(tools.get('advisor_get_plan').timeoutMs >= 110000);
  for (const tool of tools.values()) assert.match(tool.description, /status only, never file contents\/diffs\/logs\/secrets/);
  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.equal(provider.name, 'dsh-chatgpt-bridge');
  const [entry] = await provider.list();
  const skill = await provider.get('chatgpt-advisor');
  assert.equal(entry.name, 'chatgpt-advisor');
  assert.equal(skill.name, entry.name);
  assert.equal(entry.source, 'bundled');
  assert.equal(entry.provider, provider.name);
  assert.deepEqual(entry.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(entry.resourceBase.kind, 'directory');
  assert.equal(entry.locator, entry.path);
  assert.equal(entry.rank, 600);
  assert.match(entry.path, /skills[\\/]chatgpt-advisor[\\/]SKILL\.md$/);
  assert.ok(!skill.content.startsWith('---'));
  assert.match(skill.content, /advisor_init/);
  assert.deepEqual(warnings, []);
  for (const dispose of disposers.splice(0)) dispose();
  assert.equal(tools.size, 0);
  assert.equal(providers.length, 0);
});

test('advisor agent tools: complete DSH loop through executed, handoff, revised plan and done', async (t) => {
  const { call, runtime } = await setup(t);
  const init = await call('advisor_init', { goal: 'Improve the example.', workspace: workspace.title });
  const { task_id } = init;
  assert.deepEqual(init, { task_id, state: 'INIT', iteration: 0, next: 'call advisor_get_plan' });
  const firstWait = call('advisor_get_plan', { task_id });
  assert.equal((await runtime.store.waitRequest({ wait_ms: 0 })).request.kind, 'INIT');
  await runtime.store.submitPlan({ task_id, iteration: 1, ...plan });
  assert.deepEqual((await firstWait).plan, plan);
  assert.equal((await call('advisor_executed', { task_id, ...executed })).state, 'EXECUTED');
  assert.equal((await runtime.store.waitRequest({ wait_ms: 0 })).request.kind, 'EXECUTED');
  const secondWait = call('advisor_get_plan', { task_id, wait_seconds: 1 });
  await runtime.store.submitVerdict({ task_id, iteration: 1, verdict: 'plan', plan });
  assert.equal((await secondWait).iteration, 2);
  assert.equal((await call('advisor_handoff', { task_id, reason: 'Review the next decision.' })).state, 'HANDOFF');
  assert.equal((await runtime.store.waitRequest({ wait_ms: 0 })).request.kind, 'HANDOFF');
  const finalWait = call('advisor_get_plan', { task_id });
  await runtime.store.submitVerdict({ task_id, iteration: 2, verdict: 'done' });
  assert.deepEqual(await finalWait, { task_id, state: 'DONE', terminal: true, verdict: 'done' });
  // A terminal task releases the session for another task.
  assert.equal((await call('advisor_init', { goal: 'Next task.' })).state, 'INIT');
});

test('advisor agent tools: session cwd resolves a registered workspace and records the calling agent id', async (t) => {
  const { call, runtime } = await setup(t);
  const { task_id } = await call('advisor_init', { goal: 'Use session cwd.' });
  const task = await runtime.store.getTask(task_id);
  assert.equal(task.workspace_id, workspace.id);
  assert.equal(task.session_id, 'agent-one');
});

test('advisor agent tools: unknown explicit workspace never falls back to the session cwd', async (t) => {
  const { call, runtime } = await setup(t);
  await assert.rejects(call('advisor_init', { goal: 'Check registration.', workspace: 'unregistered' }), /WORKSPACE_NOT_FOUND/);
  await assert.rejects(call('advisor_init', { goal: 'Check cwd.' }, agent('other', join(workspace.path, 'unregistered'))), /WORKSPACE_NOT_FOUND/);
  await assert.rejects(call('advisor_init', { goal: 'No caller.' }, null), /WORKSPACE_NOT_FOUND/);
  assert.deepEqual(await runtime.store.listTasks(), []);
});

test('advisor agent tools: explicit workspace works without an agent', async (t) => {
  const { tools, runtime } = await setup(t);
  const init = await tools.get('advisor_init').execute({ goal: 'Explicit workspace.', workspace: workspace.id }, {});
  assert.equal((await runtime.store.getTask(init.task_id)).session_id, undefined);
});

test('advisor agent tools: a second init for an active session is rejected with its task id, including concurrent calls', async (t) => {
  const { call, runtime } = await setup(t);
  const results = await Promise.allSettled([
    call('advisor_init', { goal: 'First task.' }), call('advisor_init', { goal: 'Second task.' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /TASK_ALREADY_ACTIVE/);
  assert.ok(results[1].reason.message.includes(results[0].value.task_id));
  assert.equal((await runtime.store.listTasks()).length, 1);
});

test('advisor agent tools: every task operation enforces ownership before changing task state', async (t) => {
  const { call, runtime } = await setup(t);
  const { task_id } = await call('advisor_init', { goal: 'Owned task.' });
  for (const [tool, args] of [
    ['advisor_get_plan', { task_id, wait_seconds: 1 }],
    ['advisor_executed', { task_id, ...executed }],
    ['advisor_handoff', { task_id, reason: 'Needs review.' }],
  ]) await assert.rejects(call(tool, args, agent('agent-two')), /TASK_NOT_OWNED/);
  assert.equal((await runtime.store.getTask(task_id)).state, 'INIT');
});

test('advisor agent tools: find pre-existing session tasks and fail closed when the store listing is capped', async (t) => {
  const { call, runtime } = await setup(t);
  const old = await runtime.store.createTask({ workspace_id: workspace.id, goal: 'Pre-existing task.', session_id: 'restored' });
  await assert.rejects(call('advisor_init', { goal: 'Duplicate.' }, agent('restored')), (error) => {
    assert.match(error.message, /TASK_ALREADY_ACTIVE/);
    return error.message.includes(old.task_id);
  });
  const known = await call('advisor_init', { goal: 'Track this session.' });
  for (let i = 0; i < 100; i++) {
    await runtime.store.createTask({ workspace_id: workspace.id, goal: `Other task ${i}.`, session_id: `other-${i}` });
  }
  await assert.rejects(call('advisor_init', { goal: 'Duplicate beyond listing cap.' }), (error) => {
    assert.match(error.message, /TASK_ALREADY_ACTIVE/);
    return error.message.includes(known.task_id);
  });
  await assert.rejects(call('advisor_init', { goal: 'Unknown session.' }, agent('unknown')), /TASK_LOOKUP_LIMIT/);
});

test('advisor agent tools: reject wait bounds and oversized status fields before mutation', async (t) => {
  const { call, runtime } = await setup(t);
  const { task_id } = await call('advisor_init', { goal: 'Validate inputs.' });
  for (const wait_seconds of [101, 0, 1.5]) {
    await assert.rejects(call('advisor_get_plan', { task_id, wait_seconds }), /INVALID_ARGUMENT|ToolArgsError/);
  }
  await runtime.store.submitPlan({ task_id, iteration: 1, ...plan });
  await call('advisor_get_plan', { task_id });
  for (const invalid of [
    { summary: 'x'.repeat(2049) }, { summary: ' ' }, { iteration: 0 }, { changed_files_count: -1 },
    { tests: Array.from({ length: 51 }, () => ({ name: 'unit', status: 'passed' })) },
    { tests: [{ name: 'x'.repeat(2049), status: 'passed' }] },
    { tests: [{ name: 'unit', status: 'unknown' }] },
  ]) await assert.rejects(call('advisor_executed', { task_id, ...executed, ...invalid }), /INVALID_ARGUMENT|ToolArgsError/);
  await assert.rejects(call('advisor_handoff', { task_id, reason: 'x'.repeat(2049) }), /INVALID_ARGUMENT/);
  assert.equal((await runtime.store.getTask(task_id)).state, 'EXECUTING');
});

test('advisor agent tools: redact canonical output and render one JSON text block', async (t) => {
  const { call, tools, runtime } = await setup(t);
  const { task_id } = await call('advisor_init', { goal: 'Check output masking.' });
  await runtime.store.submitPlan({ task_id, iteration: 1, ...plan });
  await call('advisor_get_plan', { task_id });
  // Synthetic credential-shaped value only; no real credential is used.
  const args = { task_id, ...executed, summary: 'api_key=sk-abcdefghijklmnop' };
  const value = await call('advisor_executed', args);
  assert.equal(value.last_executed.summary, '[REDACTED]');
  const blocks = tools.get('advisor_executed').output.render(args, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.deepEqual(JSON.parse(blocks[0].text), value);
  assert.ok(!blocks[0].text.includes(args.summary));
});

test('advisor agent tools: controller guard registers no tools, skills or optional injections', async (t) => {
  const { tools, providers, injections } = await setup(t, 'controller');
  assert.equal(tools.size, 0);
  assert.deepEqual(providers, []);
  assert.deepEqual(injections, []);
});

test('advisor agent tools: skills can register without a tools service and tools without skills', async (t) => {
  const withoutTools = await setup(t, 'advisor', { unavailable: ['tools'] });
  assert.equal(withoutTools.tools.size, 0);
  assert.equal(withoutTools.providers.length, 1);
  const withoutSkills = await setup(t, 'advisor', { unavailable: ['skills'] });
  assert.equal(withoutSkills.tools.size, 4);
  assert.equal(withoutSkills.providers.length, 0);
});
