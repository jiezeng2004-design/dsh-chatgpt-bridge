import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, lastTurnEnd, foldPendingMessages, undecidedApprovals, openAskUserQuestions } from '../../lib/status.js';

const ev = (type, data, seq = 0, time = 0) => ({ type, seq, time, data });

test('deriveStatus: fork seed closure is forked, not completed, and new work wins', () => {
  const input = { pendingApprovals: 0, pendingQuestions: 0, events: [
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'forked' } }, 1),
  ] };
  assert.equal(deriveStatus(input), 'forked');
  assert.equal(deriveStatus({ ...input, hasPendingInbox: true }), 'queued');
  assert.equal(deriveStatus({ ...input, agentStatus: 'running' }), 'running');
});

test('deriveStatus: fresh session is idle', () => {
  assert.equal(deriveStatus({ pendingApprovals: 0, pendingQuestions: 0, events: [] }), 'idle');
});

test('deriveStatus: queued when inbox pending', () => {
  assert.equal(
    deriveStatus({ pendingApprovals: 0, pendingQuestions: 0, hasPendingInbox: true, events: [] }),
    'queued',
  );
});

test('deriveStatus: running wins over queued', () => {
  assert.equal(
    deriveStatus({ agentStatus: 'running', hasPendingInbox: true, pendingApprovals: 0, pendingQuestions: 0, events: [] }),
    'running',
  );
});

test('deriveStatus: waiting_for_approval wins over running', () => {
  assert.equal(
    deriveStatus({ agentStatus: 'running', pendingApprovals: 1, pendingQuestions: 0, events: [] }),
    'waiting_for_approval',
  );
});

test('deriveStatus: waiting_for_user wins over running', () => {
  assert.equal(
    deriveStatus({ agentStatus: 'running', pendingApprovals: 0, pendingQuestions: 2, events: [] }),
    'waiting_for_user',
  );
});

test('deriveStatus: completed after completed turn', () => {
  const events = [
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1),
  ];
  assert.equal(deriveStatus({ pendingApprovals: 0, pendingQuestions: 0, events }), 'completed');
});

test('deriveStatus: failed after error turn', () => {
  const events = [
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'LLM_FAULT', message: 'boom' } } }, 1),
  ];
  assert.equal(deriveStatus({ pendingApprovals: 0, pendingQuestions: 0, events }), 'failed');
});

test('deriveStatus: cancelled after aborted turn', () => {
  const events = [
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1),
  ];
  assert.equal(deriveStatus({ pendingApprovals: 0, pendingQuestions: 0, events }), 'cancelled');
});

test('deriveStatus: last turn wins across turns', () => {
  const events = [
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1),
    ev('turn/start', { turn: 2 }, 2),
    ev('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'X', message: 'y' } } }, 3),
  ];
  assert.equal(deriveStatus({ pendingApprovals: 0, pendingQuestions: 0, events }), 'failed');
});

test('lastTurnEnd finds the last turn/end', () => {
  const events = [
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1),
    ev('turn/start', { turn: 2 }, 2),
  ];
  const last = lastTurnEnd(events);
  assert.equal(last.turn, 1);
  assert.equal(last.reason.kind, 'completed');
});

test('foldPendingMessages: inbox splices recover pending counts', () => {
  const events = [
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm1', role: 'user', content: [], source: { kind: 'user' } }] }, 0),
    ev('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'm2', role: 'user', content: [], source: { kind: 'user' } }] }, 1),
    ev('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 2),
  ];
  const folded = foldPendingMessages(events);
  assert.equal(folded.nextTurn, 1);
  assert.equal(folded.nextStep, 0);
});

test('undecidedApprovals: asked without decided remains pending', () => {
  const events = [
    ev('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1' }, 0),
    ev('approval/asked', { id: 'a2', toolName: 'write' }, 1),
    ev('approval/decided', { id: 'a1', outcome: 'allowed-once' }, 2),
  ];
  const pending = undecidedApprovals(events);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'a2');
  assert.equal(pending[0].toolName, 'write');
});

test('openAskUserQuestions: open call without result', () => {
  const events = [
    ev('tool/call', { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: '{"questions":[]}' }, 0),
    ev('tool/call', { turn: 1, step: 1, callId: 'q2', name: 'ask_user_question', arguments: '{}' }, 1),
    ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'q1' } } }, 2),
  ];
  const open = openAskUserQuestions(events);
  assert.equal(open.length, 1);
  assert.equal(open[0].callId, 'q2');
});
