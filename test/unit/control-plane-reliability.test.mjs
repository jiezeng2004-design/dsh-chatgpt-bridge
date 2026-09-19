import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Bridge, BridgeError } from '../../lib/bridge.js';

const MIX = {
  id: 'ws-1',
  title: 'mix_workspace',
  path: 'D:\\Agent\\agent_workplace\\mix_workspace',
  createdAt: 'x',
  updatedAt: 'x',
  sessionIds: [],
};

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
      agent.followupCount += 1;
      agent.status = extras.followupStatus ?? 'running';
      inbox.hasPending = true;
      inbox.nextTurn = inbox.nextTurn ?? [];
      inbox.nextTurn.push(message ?? { id: 'm' });
    },
    cancel() {
      agent.cancelCount += 1;
      agent.status = 'idle';
      inbox.hasPending = false;
      inbox.nextTurn = [];
      inbox.nextStep = [];
    },
    followupCount: 0,
    cancelCount: 0,
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
  const services = {
    workspaceRegistry: { list: () => [workspace] },
    agents: agentsApi,
    sessions: { list: () => [...agents.values()].map((agent) => agent.session), get: (id) => agents.get(id)?.session },
    sessionPersistence: {
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
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: { rename() {}, get: () => undefined },
    on: () => {},
  };
  const bridge = new Bridge(
    ctx,
    { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  return { bridge, agents, created };
}

async function waitForApproval(bridge, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bridge['approvals'].size > 0) return [...bridge['approvals'].keys()][0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for parked approval');
}

function toolCall(seq, callId, command) {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

function fileToolCall(seq, callId, name, args) {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 1, callId, name, arguments: JSON.stringify(args) },
  };
}

function toolResult(seq, callId, content, isError = false) {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: { turn: 1, message: { source: { callId }, content: [{ type: 'tool', isError, content }] } },
  };
}

test('R1 / A01: identical Goal sent three times reuses one session and does not bump revision', async () => {
  const { bridge, created } = makeStatefulBridge();
  const input = { workspace: 'ws-1', goal: 'Run the full npm test suite' };
  const first = await bridge.startGoal(input);
  const second = await bridge.startGoal(input);
  const third = await bridge.startGoal(input);

  assert.equal(created.length, 1);
  assert.equal(second.session_id, first.session_id);
  assert.equal(third.session_id, first.session_id);
  assert.equal(second.existing_goal_reused, true);
  assert.equal(third.existing_goal_reused, true);
  assert.equal(second.revision_unchanged, true);
  assert.equal(third.revision_unchanged, true);
  assert.equal(first.goal?.revision ?? 1, 1);
  assert.equal(second.goal?.revision ?? 1, 1);
});

test('terminal identical Goals are not reused as active sessions', async () => {
  const { bridge, agents, created } = makeStatefulBridge();
  const input = { workspace: 'ws-1', goal: 'Run the full npm test suite' };
  const first = await bridge.startGoal(input);
  const agent = agents.get(first.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  agent.inbox.nextStep = [];
  agent.session.events.push({
    type: 'turn/end',
    seq: 1,
    time: 1,
    data: { turn: 1, reason: { kind: 'completed' } },
  });
  assert.equal((await bridge.getTaskStatus(first.session_id)).status, 'completed');

  const second = await bridge.startGoal(input);
  assert.notEqual(second.session_id, first.session_id);
  assert.equal(created.length, 2);
});

test('startGoal enforces expected_revision on an existing session', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'Prepare release candidate 1' });
  const agent = agents.get(first.session_id);
  const followupsBefore = agent.followupCount;

  await assert.rejects(
    () => bridge.startGoal({
      workspace: 'ws-1',
      session_id: first.session_id,
      goal: 'Prepare release candidate 2',
      expected_revision: 0,
    }),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'REVISION_CONFLICT');
      return true;
    },
  );
  assert.equal(bridge.goalStore.get(first.session_id)?.revision, 1);
  assert.equal(agent.followupCount, followupsBefore);

  const revised = await bridge.startGoal({
    workspace: 'ws-1',
    session_id: first.session_id,
    goal: 'Prepare release candidate 2',
    expected_revision: 1,
  });
  assert.equal(revised.goal?.revision, 2);
});

test('R4 / A07: second mutable Goal on the same workspace is locked without override', async () => {
  const { bridge, created } = makeStatefulBridge();
  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'Edit files and commit the fix' });
  assert.equal(created.length, 1);

  await assert.rejects(
    () => bridge.startGoal({ workspace: 'ws-1', goal: 'Publish a different release' }),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'WORKSPACE_LOCKED');
      assert.equal(error.details?.status, 'waiting_for_workspace_lock');
      assert.equal(error.details?.holder_session_id, first.session_id);
      return true;
    },
  );
  assert.equal(created.length, 1);

  const audit = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'Audit git log and review the package manifest',
    constraints: { read_only: true },
  });
  assert.notEqual(audit.session_id, first.session_id);

  const override = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'Take over and continue the release',
    workspace_lock_override: true,
  });
  assert.notEqual(override.session_id, first.session_id);
  assert.equal(bridge.workspaceGuard.getLock(MIX.path)?.sessionId, override.session_id);
});

test('R5 / A05: when approve is blocked by the platform layer, reject and stop still converge', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Publish package to npm registry' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(toolCall(1, 'c-pub', 'npm publish'));

  const parked = bridge.decideApproval({ agent, toolName: 'bash', callId: 'c-pub', reason: 'publish' });
  const approvalId = await waitForApproval(bridge);
  assert.equal(bridge['approvals'].size, 1);

  bridge['apiProxy'] = { respond: async () => ({ accepted: false, reason: 'platform-deny' }) };
  const pending = bridge['approvals'].get(approvalId);
  pending.muxRpcId = 'rpc-blocked';

  await assert.rejects(
    () => bridge.approve(started.session_id, approvalId, 'approve'),
    (error) => {
      assert.equal(error.code, 'APPROVAL_UNREACHABLE');
      assert.equal(error.details?.layer, 'platform');
      assert.equal(error.details?.reject_reachable, true);
      assert.equal(error.details?.cancel_reachable, true);
      return true;
    },
  );
  assert.equal(bridge['approvals'].has(approvalId), true);

  const rejected = await bridge.approve(started.session_id, approvalId, 'reject');
  assert.equal(rejected.fail_closed, true);
  assert.equal(rejected.layer, 'platform');
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(bridge['approvals'].size, 0);
  assert.equal(await parked, 'rejected');

  agent.session.events.push(toolCall(2, 'c-pub-2', 'npm publish'));
  const parkedAgain = bridge.decideApproval({ agent, toolName: 'bash', callId: 'c-pub-2' });
  const secondId = await waitForApproval(bridge);
  bridge['approvals'].get(secondId).muxRpcId = 'rpc-blocked-2';
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.stopped, true);
  assert.equal(bridge['approvals'].size, 0);
  assert.equal(await parkedAgain, 'cancelled');
});

test('write approval distinguishes workspace paths from external paths', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Update one file' });
  const agent = agents.get(started.session_id);

  agent.session.events.push(fileToolCall(1, 'c-inside', 'write', { file_path: 'src/inside.ts', content: 'x' }));
  assert.equal(await bridge.decideApproval({ agent, toolName: 'write', callId: 'c-inside' }), 'approved');

  agent.session.events.push(fileToolCall(2, 'c-outside', 'write', { file_path: join('..', 'outside.ts'), content: 'x' }));
  const parked = bridge.decideApproval({ agent, toolName: 'write', callId: 'c-outside' });
  const approvalId = await waitForApproval(bridge);
  const pending = bridge['approvals'].get(approvalId);
  assert.equal(pending.capability, 'external_path.write');
  assert.equal(await bridge.approve(started.session_id, approvalId, 'reject').then((item) => item.outcome), 'rejected');
  assert.equal(await parked, 'rejected');
});

test('R7 / A10: duplicate npm test after observed PASS is skipped with SKIPPED_ALREADY_VERIFIED', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Run the full npm test suite' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(
    toolCall(1, 'c-test-1', 'npm test'),
    toolResult(2, 'c-test-1', '✔ pass 203\nℹ tests 203\nℹ fail 0'),
  );
  await bridge.getTaskStatus(started.session_id);

  agent.session.events.push(toolCall(3, 'c-test-2', 'npm test'));
  const outcome = await bridge.decideApproval({ agent, toolName: 'bash', callId: 'c-test-2' });
  assert.equal(outcome, 'rejected');

  const status = await bridge.getTaskStatus(started.session_id);
  assert.ok(status.history?.some((event) => event.type === 'step_skipped' && event.metadata?.code === 'SKIPPED_ALREADY_VERIFIED'));
});

test('structured result excludes evidence owned only by another session', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Inspect current state' });
  bridge.idempotencyManager.recordSuccess('foreign-fingerprint', {
    kind: 'test',
    sessionId: 'another-session',
    workspacePath: MIX.path,
  });

  const result = await bridge.getStructuredResult(started.session_id);
  assert.deepEqual(result.tests.evidence_ids, []);
});

test('R8 / A11: duplicate npm publish after observed success is skipped with SKIPPED_ALREADY_APPLIED', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Publish package to npm registry' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(
    toolCall(1, 'c-pub-1', 'npm publish'),
    toolResult(2, 'c-pub-1', 'probemux@0.1.0 published'),
  );
  await bridge.getTaskStatus(started.session_id);

  agent.session.events.push(toolCall(3, 'c-pub-2', 'npm publish'));
  const outcome = await bridge.decideApproval({ agent, toolName: 'bash', callId: 'c-pub-2' });
  assert.equal(outcome, 'rejected');

  const status = await bridge.getTaskStatus(started.session_id);
  assert.ok(
    status.history?.some((event) => event.type === 'step_skipped' && event.metadata?.code === 'SKIPPED_ALREADY_APPLIED'),
    JSON.stringify(status.history),
  );
});

test('A11: a real approved publish records evidence independently from mutation provenance', async () => {
  const { bridge, agents } = makeStatefulBridge();
  bridge.approvalPolicy = { npmPublish: 'auto' };
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Publish package to npm registry' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(toolCall(1, 'c-pub-approved', 'npm publish'));
  assert.equal(
    await bridge.decideApproval({ agent, toolName: 'bash', callId: 'c-pub-approved' }),
    'approved',
  );

  agent.session.events.push(toolResult(2, 'c-pub-approved', 'dsh-chatgpt-bridge@0.5.0 published'));
  await bridge.getTaskStatus(started.session_id);
  assert.equal(bridge.idempotencyManager.listEvidence().filter((item) => item.kind === 'npm_publish').length, 1);

  agent.session.events.push(toolCall(3, 'c-pub-replay', 'npm publish'));
  assert.equal(
    await bridge.decideApproval({ agent, toolName: 'bash', callId: 'c-pub-replay' }),
    'rejected',
  );
  const status = await bridge.getTaskStatus(started.session_id);
  assert.ok(status.history?.some((event) => event.type === 'step_skipped' && event.metadata?.code === 'SKIPPED_ALREADY_APPLIED'));
});

test('R9 / A09: pause and resume use the same live Goal checkpoint without replaying completed actions', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'Create the release tag, then publish the package',
    plan: '1. git tag v0.5.0\n2. npm publish',
  });
  const agent = agents.get(started.session_id);
  agent.session.events.push(
    toolCall(1, 'c-tag-1', 'git tag v0.5.0'),
    toolResult(2, 'c-tag-1', 'tag v0.5.0 created'),
  );

  const paused = await bridge.pauseGoal(started.session_id);
  assert.equal(paused.paused, true);
  assert.equal(agent.cancelCount, 1);
  assert.equal(agent.status, 'idle');

  const resumed = await bridge.resumeGoal(started.session_id, ['npm_publish'], 'resume-once');
  assert.equal(resumed.session_id, started.session_id);
  assert.equal(agent.followupCount, 2);
  assert.equal(agent.status, 'running');
  const record = bridge.goalStore.get(started.session_id);
  assert.ok(record.completed_action_kinds.includes('git_tag'));
  assert.equal(record.deferred_step_ids.includes('git_tag'), false);
  assert.equal(record.revision, 2);
});

test('A10: dsh_rerun_step invalidates the resolved test kind and permits a fresh approval', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'Run npm test',
    plan: '1. npm test',
  });
  const agent = agents.get(started.session_id);
  agent.session.events.push(
    toolCall(1, 'c-test-first', 'npm test'),
    toolResult(2, 'c-test-first', '✔ pass 203\nℹ tests 203\nℹ fail 0'),
  );
  await bridge.getTaskStatus(started.session_id);
  assert.equal(bridge.idempotencyManager.listEvidence().filter((item) => item.kind === 'test').length, 1);

  await bridge.rerunStep(started.session_id, 'npm_test', 'rerun-test-once');
  assert.equal(bridge.idempotencyManager.listEvidence().filter((item) => item.kind === 'test').length, 0);

  agent.session.events.push(toolCall(3, 'c-test-second', 'npm test'));
  const outcome = await bridge.decideApproval({ agent, toolName: 'bash', callId: 'c-test-second' });
  assert.equal(outcome, 'approved');
});

test('R12 / A16: status exposes one folded Goal card after multiple real revisions', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Prepare release candidate 1' });
  await bridge.reviseGoal({ session_id: started.session_id, goal: 'Prepare release candidate 2', expected_revision: 1 });
  await bridge.reviseGoal({ session_id: started.session_id, goal: 'Prepare release candidate 3', expected_revision: 2 });
  await bridge.reviseGoal({ session_id: started.session_id, goal: 'Prepare release candidate 4', expected_revision: 3 });

  const status = await bridge.getTaskStatus(started.session_id);
  assert.equal(status.goal?.card, 'Goal rev 4');
  assert.equal(status.goal?.revision_history_folded, true);
  assert.deepEqual(status.goal?.revision_history.map((item) => item.revision), [1, 2, 3, 4]);
  assert.equal('revisions' in status.goal, false);
});
