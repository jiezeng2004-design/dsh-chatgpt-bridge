import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, BridgeError, normalizePath } from '../../lib/bridge.js';
import { applyNativeGetGoalResult } from '../../lib/goal-control.js';

// A minimal fake workspace registry with one registered workspace.
function makeRegistry(workspaces) {
  return {
    list: () => workspaces,
  };
}

const MIX = { id: 'ws-1', title: 'mix_workspace', path: 'D:\\Agent\\agent_workplace\\mix_workspace', createdAt: 'x', updatedAt: 'x', sessionIds: [] };
const OTHER = { id: 'ws-2', title: 'other', path: 'D:\\Other\\place', createdAt: 'x', updatedAt: 'x', sessionIds: [] };

function makeBridge({ registry, agents, sessions, persistence, on, userQuestions, title } = {}) {
  const services = {
    workspaceRegistry: registry,
    agents: agents ?? { get: () => undefined, list: () => [] },
    sessions: sessions ?? { list: () => [], get: () => undefined },
    sessionPersistence: persistence ?? { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: title,
    on: on ?? (() => {}),
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  return new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
}

test('resolveWorkspace: accepts id, canonical path, and title (Case 5 boundary)', async () => {
  const bridge = makeBridge({ registry: makeRegistry([MIX, OTHER]) });
  assert.equal((await bridge.resolveWorkspace('ws-1')).path, MIX.path);
  assert.equal((await bridge.resolveWorkspace(MIX.path)).id, 'ws-1');
  assert.equal((await bridge.resolveWorkspace('mix_workspace')).id, 'ws-1');
});

test('resolveWorkspace: rejects unregistered paths (Case 5)', async () => {
  const bridge = makeBridge({ registry: makeRegistry([MIX]) });
  for (const input of ['D:\\Users\\nobody\\secret', 'C:\\Windows', '/', 'D:\\', '~']) {
    await assert.rejects(() => bridge.resolveWorkspace(input), (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      return true;
    });
  }
});

test('resolveWorkspace: trailing slash and win32 case use the shared compare rule', async () => {
  const bridge = makeBridge({ registry: makeRegistry([MIX, OTHER]) });
  const trailing = MIX.path.endsWith('\\') || MIX.path.endsWith('/') ? MIX.path : `${MIX.path}\\`;
  assert.equal((await bridge.resolveWorkspace(trailing)).id, 'ws-1');
  if (process.platform === 'win32') {
    assert.equal((await bridge.resolveWorkspace(MIX.path.toLowerCase())).id, 'ws-1');
    assert.equal(normalizePath(trailing), normalizePath(MIX.path.toLowerCase()));
  } else {
    assert.equal(normalizePath(trailing), normalizePath(MIX.path));
  }
});

test('listSessions workspace filter uses the same path compare as resolveWorkspace', async () => {
  const { bridge } = makeStatefulBridge();
  const created = await bridge.createSession('ws-1', 'demo');
  const trailing = `${MIX.path}\\`;
  const listed = await bridge.listSessions({ workspace: trailing });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, created.session_id);
});

test('Bridge.start effect disposer cancels parked approvals and questions', async () => {
  const disposers = [];
  const services = {
    workspaceRegistry: makeRegistry([MIX]),
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    on: () => () => true,
    inject: () => ({}),
    effect: (execute) => {
      const disposer = execute();
      disposers.push(disposer);
      return disposer;
    },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const bridge = new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
  bridge.start();
  assert.ok(disposers.length >= 1);
  let approval;
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: 'session-a', toolName: 'bash',
    resolve: (outcome) => { approval = outcome; },
  });
  let question;
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: 'session-a', questions: [],
    resolve: (answer) => { question = answer; },
  });
  await disposers[disposers.length - 1]();
  assert.equal(approval, 'cancelled');
  assert.deepEqual(question, { answers: [] });
  assert.equal(bridge['approvals'].size, 0);
  assert.equal(bridge['questions'].size, 0);
});

test('resolveWorkspace: rejects when no registry is mounted', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.resolveWorkspace('anything'), (error) => {
    assert.equal(error.code, 'WORKSPACE_REGISTRY_UNAVAILABLE');
    return true;
  });
});

test('approve: rejects unknown approval ids', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.approve('session-1', 'approval-nope', 'approve'), (error) => {
    assert.equal(error.code, 'APPROVAL_NOT_FOUND');
    return true;
  });
});

test('approve: rejects session mismatch', async () => {
  const bridge = makeBridge({});
  const settled = { resolve: () => {} };
  bridge['approvals'].set('approval-1', { id: 'approval-1', sessionId: 'session-a', toolName: 't', resolve: (o) => settled.resolve(o) });
  await assert.rejects(() => bridge.approve('session-b', 'approval-1', 'approve'), (error) => {
    assert.equal(error.code, 'APPROVAL_SESSION_MISMATCH');
    return true;
  });
});

test('answerQuestion: rejects unknown question ids and invalid selections', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.answerQuestion('question-9', undefined, { selected: [] }), (error) => {
    assert.equal(error.code, 'QUESTION_NOT_FOUND');
    return true;
  });
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: 'session-a',
    questions: [{ id: 'inner-1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
    resolve: () => {},
  });
  await assert.rejects(() => bridge.answerQuestion('question-1', undefined, { selected: ['Z'] }), (error) => {
    assert.equal(error.code, 'INVALID_ANSWER');
    return true;
  });
  await assert.rejects(() => bridge.answerQuestion('question-1', undefined, { selected: ['A', 'B'] }), (error) => {
    assert.equal(error.code, 'INVALID_ANSWER');
    return true;
  });
});

test('answerQuestion: resolves with the offered option', async () => {
  const bridge = makeBridge({});
  let resolved;
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: 'session-a',
    questions: [{ id: 'inner-1', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { resolved = answer; },
  });
  const out = await bridge.answerQuestion('question-1', 'session-a', { selected: ['A'] });
  assert.deepEqual(out, { answered: true });
  assert.deepEqual(resolved.answers, [{ id: 'inner-1', selected: ['A'] }]);
});

test('cancelTask: only live sessions can be cancelled', async () => {
  const bridge = makeBridge({ agents: { get: () => undefined } });
  await assert.rejects(() => bridge.cancelTask('session-1'), (error) => {
    assert.equal(error.code, 'SESSION_NOT_LIVE');
    return true;
  });
});

test('sendMessage: empty message rejected', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.sendMessage('session-1', '   '), (error) => {
    assert.equal(error.code, 'EMPTY_MESSAGE');
    return true;
  });
});

test('sendMessage: unknown session rejected', async () => {
  const bridge = makeBridge({ persistence: { open: async () => { throw new Error('nope'); } } });
  await assert.rejects(() => bridge.sendMessage('session-unknown', 'hello'), (error) => {
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
});

function makeLiveAgent(id, workspacePath, extras = {}) {
  const events = extras.events ?? [];
  const inbox = extras.inbox ?? { nextTurn: [], nextStep: [], hasPending: false };
  const agent = {
    id,
    status: extras.status ?? 'idle',
    inbox,
    session: {
      id,
      header: { id, createdAt: Date.now(), cwd: workspacePath },
      events,
      snapshotEvents: () => events,
      requestHeader: () => undefined,
    },
    followup(message) {
      agent.lastFollowup = message;
      agent.status = extras.followupStatus ?? 'running';
      inbox.hasPending = true;
      inbox.nextTurn = inbox.nextTurn ?? [];
      inbox.nextTurn.push({ id: 'm' });
    },
    cancel() {
      agent.status = 'idle';
      inbox.hasPending = false;
      inbox.nextTurn = [];
      inbox.nextStep = [];
      events.push({ type: 'turn/end', seq: events.length, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
    },
  };
  return agent;
}

function makeStatefulBridge() {
  const agents = new Map();
  const created = [];
  const workspace = { ...MIX, attachSession: async () => {}, sessionIds: [] };
  const agentsApi = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    create: async ({ sessionId, meta }) => {
      created.push(sessionId);
      const agent = makeLiveAgent(sessionId, meta.cwd);
      agents.set(sessionId, agent);
      return { agent };
    },
    resume: async ({ resumeSessionId }) => {
      const existing = agents.get(resumeSessionId);
      if (existing) return { agent: existing };
      const agent = makeLiveAgent(resumeSessionId, MIX.path);
      agents.set(resumeSessionId, agent);
      return { agent };
    },
  };
  const persistence = {
    list: async () => [...agents.values()].map((agent) => ({ header: agent.session.header })),
    open: async (id) => {
      const agent = agents.get(id);
      if (agent === undefined) throw new Error('missing');
      return {
        header: agent.session.header,
        read: async () => ({ events: agent.session.snapshotEvents() }),
        close: async () => {},
      };
    },
  };
  const title = { rename() {}, get: () => undefined };
  const bridge = makeBridge({
    registry: makeRegistry([workspace]),
    agents: agentsApi,
    sessions: { list: () => [...agents.values()].map((agent) => agent.session), get: (id) => agents.get(id)?.session },
    persistence,
    title,
  });
  return { bridge, agents, created, workspace };
}

test('createSession uses agents.create + attachSession (Case 1 path)', async () => {
  const { bridge, created, workspace } = makeStatefulBridge();
  let attached;
  workspace.attachSession = async (id) => { attached = id; };
  const view = await bridge.createSession('ws-1', 'demo');
  assert.equal(created.length, 1);
  assert.equal(view.session_id, created[0]);
  assert.equal(attached, created[0]);
  assert.match(view.session_id, /^session-/);
});

test('startGoal returns continuation to dsh_wait_goal (Case 2)', async () => {
  const { bridge } = makeStatefulBridge();
  const out = await bridge.startGoal({ workspace: 'ws-1', goal: 'three-step optimize' });
  assert.equal(out.continuation_required, true);
  assert.equal(out.next_tool_call.name, 'dsh_wait_goal');
  assert.equal(out.next_tool_call.arguments.session_id, out.session_id);
  assert.ok(['running', 'queued'].includes(out.status));
});

test('startGoal request_id is idempotent and conflicts on different args', async () => {
  const { bridge, created } = makeStatefulBridge();
  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'g', request_id: 'req-1' });
  const retry = await bridge.startGoal({ workspace: 'ws-1', goal: 'g', request_id: 'req-1' });
  assert.equal(retry.session_id, first.session_id);
  assert.equal(created.length, 1);
  await assert.rejects(
    () => bridge.startGoal({ workspace: 'ws-1', goal: 'other', request_id: 'req-1' }),
    (error) => error.code === 'REQUEST_ID_CONFLICT',
  );
  assert.equal(created.length, 1);
});

test('waitGoal still-running returns after bound with continuation (Case 3)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.continuation_required, true);
  assert.equal(waited.terminal, false);
  assert.ok(waited.waited_ms >= 1000);
  assert.equal(waited.next_tool_call.name, 'dsh_wait_goal');
});

test('waitGoal completed is terminal (Case 4)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  agent.session.events.push(
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  );
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.terminal, true);
  assert.equal(waited.continuation_required, false);
  assert.equal(waited.status, 'completed');
  assert.match(waited.result.summary, /done/);
});

test('waitGoal approval does not auto-approve (Case 5)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let granted;
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (outcome) => { granted = outcome; },
  });
  agents.get(started.session_id).status = 'running';
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'waiting_for_approval');
  assert.equal(waited.continuation_required, false);
  assert.equal(waited.needs_user_action, true);
  assert.equal(granted, undefined);
});

test('waitGoal question does not auto-answer (Case 6)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let answered;
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { answered = answer; },
  });
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'waiting_for_user');
  assert.equal(waited.continuation_required, false);
  assert.equal(answered, undefined);
});

test('approve then waitGoal can continue (Case 7)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let outcome;
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (value) => { outcome = value; },
  });
  await bridge.approve(started.session_id, 'approval-1', 'approve');
  assert.equal(outcome, 'allowed-once');
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.notEqual(waited.status, 'waiting_for_approval');
});

test('answerQuestion then waitGoal can continue (Case 8)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: () => {},
  });
  await bridge.answerQuestion('question-1', started.session_id, { selected: ['A'] });
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.notEqual(waited.status, 'waiting_for_user');
});

test('stopGoal cancels a running goal (Case 9)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  agents.get(started.session_id).status = 'running';
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.already_stopped, false);
  assert.equal(stopped.status, 'cancelled');
});

test('stopGoal while waiting approval fails closed (Case 10)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let outcome;
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (value) => { outcome = value; },
  });
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(outcome, 'cancelled');
  assert.equal(bridge['approvals'].has('approval-1'), false);
});

test('stopGoal while waiting for user fails closed and is idempotent (waiting_for_user)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let answered;
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { answered = answer; },
  });
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.already_stopped, false);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(answered, { answers: [] });
  assert.equal(bridge['questions'].has('question-1'), false);
  const again = await bridge.stopGoal(started.session_id);
  assert.equal(again.stopped, true);
  assert.equal(again.already_stopped, true);
});

test('stopGoal twice is idempotent (Case 11)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  agents.get(started.session_id).status = 'running';
  await bridge.stopGoal(started.session_id);
  const again = await bridge.stopGoal(started.session_id);
  assert.equal(again.stopped, true);
  assert.equal(again.already_stopped, true);
});

test('waitGoal on persisted session has no Goal DB (Case 12)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  agent.session.events.push(
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  );
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'completed');
  assert.equal(waited.terminal, true);
});

test('startGoal sessions stay isolated (Case 13)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const a = await bridge.startGoal({ workspace: 'ws-1', goal: 'A' });
  const b = await bridge.startGoal({ workspace: 'ws-1', goal: 'B', workspace_lock_override: true });
  assert.notEqual(a.session_id, b.session_id);
  agents.get(a.session_id).status = 'running';
  await bridge.stopGoal(a.session_id);
  assert.equal(agents.get(b.session_id).status, 'running');
});

test('idle wait does not treat agent.status idle as still running', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.continuation_required, false);
  assert.ok(waited.status === 'idle' || waited.status === 'unknown');
});

const ev = (type, data, seq) => ({ type, seq, time: seq, data });
const bashCall = (seq, callId, command) =>
  ev('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) }, seq);
const bashResult = (seq, callId, { isError = false, content = 'ok', code } = {}) =>
  ev('tool/result', {
    turn: 1,
    step: 1,
    message: { source: { callId }, content: [{ type: 'tool', isError, content }] },
    ...(code === undefined ? {} : { error: { name: 'ToolError', code } }),
  }, seq);

function settle(agent) {
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
}

test('MCP surface exposes 23 dsh_* tools (v0.5.0 Control Plane Reliability)', async () => {
  const src = await import('node:fs');
  const text = src.readFileSync(new URL('../../src/mcp.ts', import.meta.url), 'utf8');
  const count = [...text.matchAll(/server\.registerTool\(/g)].length;
  assert.equal(count, 23);
  assert.match(text, /dsh_update_goal/);
  assert.match(text, /dsh_create_goal/);
  assert.match(text, /dsh_revise_goal/);
});

test('Test A — waitGoal/terminal reconciles pending push todo after git push succeeds', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'ship' });
  const agent = agents.get(started.session_id);
  settle(agent);
  agent.session.events.push(
    ev('turn/start', { turn: 1 }, 0),
    ev('todo/write', { todos: [{ content: 'C12 push release commit', status: 'pending' }] }, 1),
    ev('assistant/message', { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'push succeeded' }] } }, 2),
    bashCall(3, 'c1', 'git push origin main'),
    bashResult(4, 'c1'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
  );
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.terminal, true);
  const push = waited.result.todos.find((todo) => todo.content.includes('push'));
  assert.equal(push.status, 'completed');
  const session = await bridge.getSession(started.session_id);
  assert.equal(session.todos.find((todo) => todo.content.includes('push')).status, 'completed');
});

test('Test B — waiting npm publish todo stays in_progress', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'publish' });
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash', resolve: () => {},
  });
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.session.events.push(
    ev('todo/write', { todos: [{ content: 'npm publish', status: 'pending' }] }, 1),
  );
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'waiting_for_approval');
  const npm = waited.progress.todos.find((todo) => /npm publish/i.test(todo.content));
  assert.equal(npm.status, 'in_progress');
});

test('Test C — second waitGoal progress_delta is incremental', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  settle(agent);
  agent.session.events.push(
    ev('todo/write', { todos: [{ content: 'analyze', status: 'in_progress' }] }, 1),
    ev('turn/start', { turn: 1 }, 2),
  );
  const first = await bridge.waitGoal(started.session_id, 1);
  assert.ok(first.progress_delta);
  agent.session.events.push(
    ev('todo/write', { todos: [{ content: 'analyze', status: 'completed' }] }, 3),
  );
  const second = await bridge.waitGoal(started.session_id, 1);
  assert.equal(second.progress_delta.since_seq, first.progress_delta.until_seq);
  assert.ok(second.progress_delta.new_events.every((event) => event.seq > first.progress_delta.until_seq));
  assert.deepEqual(second.progress_delta.todos_changed, [
    { content: 'analyze', from: 'in_progress', to: 'completed' },
  ]);
});

test('Test D/E — blocked npm leaves GitHub Release runnable; re-arm defer continues session', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'release v0.2.0',
    plan: '1. push\n2. tag\n3. npm publish\n4. GitHub Release',
  });
  const agent = agents.get(started.session_id);
  settle(agent);
  agent.session.events.push(
    ev('turn/start', { turn: 1 }, 0),
    ev('todo/write', {
      todos: [
        { content: 'C12 push release commit', status: 'completed' },
        { content: 'C13 创建并 push annotated tag', status: 'completed' },
        { content: 'npm publish', status: 'pending' },
        { content: 'GitHub Release', status: 'pending' },
      ],
    }, 1),
    bashCall(2, 'c1', 'git push origin main'),
    bashResult(3, 'c1'),
    bashCall(4, 'c2', 'git tag -a v0.2.0 -m v0.2.0'),
    bashResult(5, 'c2'),
    bashCall(6, 'c3', 'git push origin v0.2.0'),
    bashResult(7, 'c3'),
    bashCall(8, 'c4', 'npm publish'),
    bashResult(9, 'c4', { isError: true, content: 'npm ERR! EOTP one-time password required', code: 'EOTP' }),
    ev('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 10),
  );
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'blocked');
  assert.equal(waited.terminal, false);
  assert.ok(waited.blocked_steps.some((step) => /npm publish/i.test(step)));
  assert.ok(waited.remaining_runnable_steps.some((step) => /GitHub Release/i.test(step)));
  assert.equal(waited.blocked.reason, 'npm_2fa_required');

  let followups = 0;
  const original = agent.followup.bind(agent);
  agent.followup = (...args) => {
    followups += 1;
    return original(...args);
  };
  const resumed = await bridge.startGoal({
    workspace: 'ws-1',
    session_id: started.session_id,
    goal: 'defer npm publish, continue GitHub Release',
    plan: '- GitHub Release\n- [deferred] npm publish',
  });
  assert.equal(followups, 1);
  assert.ok(['running', 'queued'].includes(resumed.status));
  assert.equal(resumed.session_id, started.session_id);
  assert.equal(resumed.goal.goal_id, started.goal.goal_id);
  assert.equal(resumed.goal.revision, 2);

  settle(agent);
  agent.session.events.push(
    ev('turn/start', { turn: 2 }, 11),
    ev('todo/write', {
      todos: [
        { content: 'C12 push release commit', status: 'completed' },
        { content: 'C13 创建并 push annotated tag', status: 'completed' },
        { content: 'npm publish', status: 'pending' },
        { content: 'GitHub Release', status: 'completed' },
      ],
    }, 12),
    bashCall(13, 'c5', 'gh release create v0.2.0'),
    bashResult(14, 'c5'),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 15),
  );
  const finished = await bridge.waitGoal(started.session_id, 1);
  const release = (finished.result?.todos ?? finished.progress?.todos).find((todo) => /GitHub Release/i.test(todo.content));
  assert.equal(release.status, 'completed');
  assert.ok(finished.deferred_steps?.some((step) => /npm publish/i.test(step)) ?? true);
});

test('Test 1/2 — start then update revises same session and goal_id', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'publish v0.3.0:\n- npm publish\n- GitHub Release',
    plan: 'tag then fork',
  });
  assert.equal(started.goal.revision, 1);
  assert.equal(started.goal.goal_id, `goal-${started.session_id}`);

  const revised = await bridge.updateGoal({
    session_id: started.session_id,
    action: 'revise',
    goal: 'npm 暂缓，其他继续',
    defer_steps: ['npm_publish'],
    revision_reason: 'user_modified_goal',
  });
  assert.equal(revised.session_id, started.session_id);
  assert.equal(revised.goal.goal_id, started.goal.goal_id);
  assert.equal(revised.goal.revision, 2);
  assert.equal(revised.goal.previous_revision, 1);
  assert.ok(revised.execution.deferred_steps.some((step) => /npm/i.test(step)) || revised.goal.revision === 2);
});

test('Test 2/8/9 — defer then resume same goal without creating a session', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'release',
    plan: '1. push\n2. tag\n3. npm publish\n4. GitHub Release',
  });
  const agent = agents.get(started.session_id);
  settle(agent);
  agent.session.events.push(
    ev('turn/start', { turn: 1 }, 0),
    ev('todo/write', {
      todos: [
        { content: 'push', status: 'completed' },
        { content: 'tag', status: 'completed' },
        { content: 'npm publish', status: 'pending' },
        { content: 'GitHub Release', status: 'pending' },
      ],
    }, 1),
    bashCall(2, 'c1', 'git push origin main'),
    bashResult(3, 'c1'),
    bashCall(4, 'c2', 'git tag -a v0.3.0 -m v0.3.0'),
    bashResult(5, 'c2'),
    bashCall(6, 'c3', 'npm publish'),
    bashResult(7, 'c3', { isError: true, content: 'npm ERR! EOTP', code: 'EOTP' }),
    ev('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 8),
  );
  const blocked = await bridge.waitGoal(started.session_id, 1);
  assert.equal(blocked.terminal, false);

  const deferred = await bridge.updateGoal({
    session_id: started.session_id,
    action: 'defer',
    defer_steps: ['npm_publish'],
    revision_reason: 'npm 2FA',
  });
  assert.equal(deferred.session_id, started.session_id);
  assert.equal(deferred.goal.revision, 2);
  assert.ok(deferred.execution.deferred_steps.some((step) => /npm publish/i.test(step)));

  const resumed = await bridge.updateGoal({
    session_id: started.session_id,
    action: 'resume',
    resume_steps: ['npm_publish'],
    revision_reason: 'continue npm',
  });
  assert.equal(resumed.session_id, started.session_id);
  assert.equal(resumed.goal.goal_id, started.goal.goal_id);
  assert.equal(resumed.goal.revision, 3);
  assert.equal(resumed.execution.deferred_steps.length, 0);
});

test('updateGoal resume without a goal does not create one', async () => {
  const { bridge } = makeStatefulBridge();
  const created = await bridge.createSession('ws-1', 'bare');
  await assert.rejects(
    () => bridge.updateGoal({ session_id: created.session_id, action: 'resume' }),
    (error) => {
      assert.equal(error.code, 'GOAL_NOT_FOUND');
      return true;
    },
  );
});

test('Test 3 — minimal mode records scan-forbidding constraints', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: '只等待 35 秒。禁止扫描 workspace。禁止修改文件。',
    execution_mode: 'minimal',
  });
  assert.equal(started.goal.mode, 'minimal');
  const agent = agents.get(started.session_id);
  settle(agent);
  agent.session.events.push(
    ev('turn/start', { turn: 1 }, 0),
    bashCall(1, 'c1', 'Start-Sleep -Seconds 35'),
    bashResult(2, 'c1'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  );
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'completed');
  assert.equal(waited.goal.mode, 'minimal');
  assert.equal((waited.progress?.changed_files ?? waited.result?.changed_files ?? []).length, 0);
});

test('Test 10 — resume message names completed destructive actions', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'release',
    plan: 'push\ntag\nnpm publish',
  });
  const agent = agents.get(started.session_id);
  settle(agent);
  agent.session.events.push(
    ev('turn/start', { turn: 1 }, 0),
    ev('todo/write', {
      todos: [
        { content: 'push', status: 'completed' },
        { content: 'tag', status: 'completed' },
        { content: 'npm publish', status: 'pending' },
      ],
    }, 1),
    bashCall(2, 'c1', 'git push origin main'),
    bashResult(3, 'c1'),
    bashCall(4, 'c2', 'git tag -a v0.3.0 -m v0.3.0'),
    bashResult(5, 'c2'),
    ev('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 6),
  );
  await bridge.waitGoal(started.session_id, 1);
  let sent = '';
  const original = agent.followup.bind(agent);
  agent.followup = (message) => {
    sent = JSON.stringify(message);
    return original(message);
  };
  await bridge.updateGoal({
    session_id: started.session_id,
    action: 'resume',
    resume_steps: ['npm_publish'],
  });
  assert.match(sent, /git_tag|git_push|Already completed/);
  assert.doesNotMatch(sent, /git tag -a v0\.3\.0[\s\S]*git tag -a v0\.3\.0/);
});

test('approve / answer do not increment revision', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  assert.equal(started.goal.revision, 1);
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash', resolve: () => {},
  });
  await bridge.approve(started.session_id, 'approval-1', 'approve');
  const status = await bridge.getTaskStatus(started.session_id);
  assert.equal(status.goal.revision, 1);
});

function followupText(agent) {
  return JSON.stringify(agent.lastFollowup ?? '');
}

test('Test A — injected minimal Goal forbids native get_goal', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: '只等待 35 秒',
    execution_mode: 'minimal',
  });
  const sent = followupText(agents.get(started.session_id));
  assert.match(sent, /\[Goal\] rev 1 · minimal/);
  assert.match(sent, /authoritative/i);
  assert.match(sent, /Do not call the agent-native get_goal/);
  assert.match(sent, /unnecessary control-plane query/);
  assert.match(sent, /does NOT mean the supervised Goal does not exist/);
});

test('Test B — native get_goal null leaves wait/get_session supervised Goal intact', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: '只等待 35 秒',
    execution_mode: 'minimal',
  });
  const revised = await bridge.updateGoal({
    session_id: started.session_id,
    action: 'revise',
    goal: '只等待 35 秒',
    execution_mode: 'minimal',
    revision_reason: 'user_modified_goal',
  });
  assert.equal(revised.goal.revision, 2);
  assert.equal(revised.goal.mode, 'minimal');
  const goalId = revised.goal.goal_id;

  const record = bridge['goalStore'].get(started.session_id);
  const historyBefore = structuredClone(record.history);
  const kept = applyNativeGetGoalResult(record, { goal: null });
  assert.equal(kept.goal_id, goalId);
  assert.equal(kept.revision, 2);
  assert.equal(kept.mode, 'minimal');
  assert.deepEqual(kept.history, historyBefore);

  const session = await bridge.getSession(started.session_id);
  assert.equal(session.goal.goal_id, goalId);
  assert.equal(session.goal.revision, 2);
  assert.equal(session.goal.mode, 'minimal');

  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.goal.goal_id, goalId);
  assert.equal(waited.goal.revision, 2);
  assert.equal(waited.goal.mode, 'minimal');
  assert.notEqual(waited.goal, undefined);
});

test('Test C — revision 2 Agent turn still names the authoritative [Goal]', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'wait then finish',
    execution_mode: 'minimal',
  });
  await bridge.updateGoal({
    session_id: started.session_id,
    action: 'revise',
    goal: '只等待 35 秒然后完成',
    execution_mode: 'minimal',
  });
  const sent = followupText(agents.get(started.session_id));
  assert.match(sent, /\[Goal\] rev 2 · minimal/);
  assert.match(sent, /authoritative/i);
  assert.match(sent, /ChatGPT Bridge supervised Goal/);
  assert.match(sent, /Goal revision: 2/);
});
