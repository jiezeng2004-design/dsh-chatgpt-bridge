import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RequestIdMap,
  SUPERVISED_GOAL_AUTHORITY,
  buildGoalMessage,
  buildSupervisedGoalContext,
  clampWaitSeconds,
  fingerprintStart,
  isActiveStatus,
  isTerminalStatus,
  mapStartGoal,
  mapWaitGoal,
  titleFromGoal,
} from '../../lib/goal.js';
import { applyRevision, createGoalRecord } from '../../lib/goal-control.js';

test('clampWaitSeconds bounds 1-30 and defaults to 25', () => {
  assert.equal(clampWaitSeconds(undefined), 25);
  assert.equal(clampWaitSeconds(0), 1);
  assert.equal(clampWaitSeconds(31), 30);
  assert.equal(clampWaitSeconds(7.9), 7);
});

test('buildGoalMessage includes goal, optional plan, and short mode instruction', () => {
  const withPlan = buildGoalMessage('Ship it', '1. analyze\n2. edit');
  assert.match(withPlan, /Goal:\nShip it/);
  assert.match(withPlan, /Plan:\n1\. analyze/);
  assert.match(withPlan, /Goal execution mode:/);
  assert.ok(withPlan.length < 800);
  const noPlan = buildGoalMessage('Only goal');
  assert.doesNotMatch(noPlan, /Plan:/);
});

test('titleFromGoal truncates the first line', () => {
  assert.equal(titleFromGoal('short'), 'short');
  assert.ok(titleFromGoal('x'.repeat(120)).endsWith('…'));
  assert.ok(titleFromGoal('x'.repeat(120)).length <= 80);
});

test('mapStartGoal: running requires dsh_wait_goal (Case 2)', () => {
  const out = mapStartGoal('session-1', 'running');
  assert.equal(out.session_id, 'session-1');
  assert.equal(out.status, 'running');
  assert.equal(out.continuation_required, true);
  assert.equal(out.next_tool_call.name, 'dsh_wait_goal');
  assert.equal(out.next_tool_call.arguments.session_id, 'session-1');
  assert.equal(out.next_tool_call.arguments.wait_seconds, 25);
});

test('mapStartGoal: queued also continues', () => {
  assert.equal(mapStartGoal('s', 'queued').continuation_required, true);
});

test('isActiveStatus is only running/queued — idle is not active', () => {
  assert.equal(isActiveStatus('running'), true);
  assert.equal(isActiveStatus('queued'), true);
  assert.equal(isActiveStatus('idle'), false);
  assert.equal(isActiveStatus('completed'), false);
  assert.equal(isTerminalStatus('completed'), true);
  assert.equal(isTerminalStatus('idle'), false);
});

test('mapWaitGoal: still running after bound (Case 3)', () => {
  const out = mapWaitGoal({
    sessionId: 's1',
    status: 'running',
    waitedMs: 25000,
    waitSeconds: 25,
    todos: [{ content: 'analyze', status: 'in_progress' }],
    lastActivity: '2026-08-14T00:00:00.000Z',
    lastTurn: { turn: 1 },
    changedFiles: ['a.ts'],
    assistantSummary: '',
    agentStatus: 'running',
  });
  assert.equal(out.terminal, false);
  assert.equal(out.continuation_required, true);
  assert.equal(out.waited_ms, 25000);
  assert.equal(out.next_tool_call.name, 'dsh_wait_goal');
  assert.equal(out.progress.todos_total, 1);
  assert.deepEqual(out.progress.changed_files, ['a.ts']);
  assert.equal(out.result, undefined);
});

test('mapWaitGoal: completed is terminal with result (Case 4)', () => {
  const out = mapWaitGoal({
    sessionId: 's1',
    status: 'completed',
    waitedMs: 1200,
    waitSeconds: 25,
    todos: [{ content: 'done', status: 'completed' }],
    lastTurn: { turn: 2, reason: 'completed' },
    changedFiles: ['b.ts'],
    assistantSummary: 'All three steps finished.',
  });
  assert.equal(out.terminal, true);
  assert.equal(out.continuation_required, false);
  assert.equal(out.next_tool_call, undefined);
  assert.equal(out.result.summary, 'All three steps finished.');
  assert.deepEqual(out.result.changed_files, ['b.ts']);
});

test('mapWaitGoal: waiting_for_approval does not auto-approve (Case 5)', () => {
  const approval = { approval_id: 'a1', tool_name: 'bash' };
  const out = mapWaitGoal({
    sessionId: 's1',
    status: 'waiting_for_approval',
    waitedMs: 40,
    waitSeconds: 25,
    changedFiles: [],
    assistantSummary: '',
    approval,
  });
  assert.equal(out.terminal, false);
  assert.equal(out.continuation_required, false);
  assert.equal(out.needs_user_action, true);
  assert.deepEqual(out.approval, approval);
  assert.match(out.next_action, /Do not auto-approve/);
});

test('mapWaitGoal: waiting_for_user does not auto-answer (Case 6)', () => {
  const question = { question_id: 'q1', questions: [{ question: 'Which file?' }] };
  const out = mapWaitGoal({
    sessionId: 's1',
    status: 'waiting_for_user',
    waitedMs: 10,
    waitSeconds: 25,
    changedFiles: [],
    assistantSummary: '',
    question,
  });
  assert.equal(out.continuation_required, false);
  assert.equal(out.needs_user_action, true);
  assert.deepEqual(out.question, question);
  assert.match(out.next_action, /Do not guess/);
});

test('mapWaitGoal: idle does not continue', () => {
  const out = mapWaitGoal({
    sessionId: 's1',
    status: 'idle',
    waitedMs: 5,
    waitSeconds: 25,
    changedFiles: [],
    assistantSummary: '',
    agentStatus: 'idle',
  });
  assert.equal(out.continuation_required, false);
  assert.equal(out.terminal, false);
  assert.match(out.next_action, /idle/i);
});

test('mapWaitGoal: failed/cancelled/blocked/interrupted are terminal', () => {
  for (const status of ['failed', 'cancelled', 'blocked', 'max-tokens', 'interrupted', 'forked']) {
    const out = mapWaitGoal({
      sessionId: 's1',
      status,
      waitedMs: 1,
      waitSeconds: 25,
      changedFiles: [],
      assistantSummary: 'stopped',
    });
    assert.equal(out.terminal, true, status);
    assert.equal(out.continuation_required, false, status);
  }
});

test('mapWaitGoal: blocked with remaining runnable steps is not terminal', () => {
  const out = mapWaitGoal({
    sessionId: 's1',
    status: 'blocked',
    waitedMs: 1,
    waitSeconds: 25,
    changedFiles: [],
    assistantSummary: 'npm blocked',
    remainingRunnableSteps: ['GitHub Release'],
    blockedSteps: ['npm publish'],
  });
  assert.equal(out.terminal, false);
  assert.equal(out.continuation_required, false);
  assert.deepEqual(out.remaining_runnable_steps, ['GitHub Release']);
});

test('fingerprintStart is stable and distinguishes fields', () => {
  const a = fingerprintStart({ workspace: 'ws', goal: 'g', plan: 'p' });
  const b = fingerprintStart({ workspace: 'ws', goal: 'g', plan: 'p' });
  const c = fingerprintStart({ workspace: 'ws', goal: 'g', plan: 'other' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('RequestIdMap is FIFO-capped', () => {
  const map = new RequestIdMap(2);
  map.set('a', { sessionId: 's1', fingerprint: '1' });
  map.set('b', { sessionId: 's2', fingerprint: '2' });
  map.set('c', { sessionId: 's3', fingerprint: '3' });
  assert.equal(map.get('a'), undefined);
  assert.equal(map.get('b').sessionId, 's2');
  assert.equal(map.get('c').sessionId, 's3');
});

function assertAuthoritativeSupervisedGoal(text) {
  assert.match(text, /ChatGPT Bridge supervised Goal/);
  assert.match(text, /\[Goal\]/);
  assert.match(text, /authoritative/i);
  assert.match(text, /get_goal/);
  assert.match(text, /does NOT mean the supervised Goal does not exist/i);
  assert.match(text, /must never override/i);
}

test('Test A — minimal supervised context forbids native get_goal', () => {
  const record = createGoalRecord({
    sessionId: 'session-35s',
    goal: '只等待 35 秒',
    mode: 'minimal',
    now: 1,
  });
  const injected = buildSupervisedGoalContext(record, record.goal, undefined, 'start');
  assertAuthoritativeSupervisedGoal(injected);
  assert.match(injected, /\[Goal\] rev 1 · minimal/);
  assert.match(injected, /Execution mode: minimal/);
  assert.match(injected, /unnecessary control-plane query/);
  assert.match(injected, /Do not call the agent-native get_goal/);
  assert.match(injected, /只等待 35 秒/);
  assert.match(injected, /single Goal card: "Goal rev 1"/);
  assert.equal(SUPERVISED_GOAL_AUTHORITY.includes('get_goal'), true);
});

test('Test C — revision 2 injection stays the authoritative [Goal]', () => {
  const first = createGoalRecord({
    sessionId: 'session-rev',
    goal: 'wait then finish',
    mode: 'minimal',
    now: 1,
  });
  const second = applyRevision(first, {
    goal: '只等待 35 秒然后完成',
    mode: 'minimal',
    revisionReason: 'user_modified_goal',
    now: 2,
  }, 'goal_revised');
  assert.equal(second.revision, 2);
  const injected = buildSupervisedGoalContext(second, second.goal, undefined, 'revise');
  assert.match(injected, /\[Goal\] rev 2 · minimal/);
  assertAuthoritativeSupervisedGoal(injected);
  assert.match(injected, /goal_id=goal-session-rev/);
  assert.match(injected, /revision=2/);
  assert.match(injected, /Goal revision: 2/);
  assert.match(injected, /single Goal card: "Goal rev 2"/);
  assert.match(injected, /not a new session, agent, or Goal/);
  assert.match(injected, /Folded history:/);
});
