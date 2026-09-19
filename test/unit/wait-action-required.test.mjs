import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../../lib/bridge.js';

function makeBridge(agent) {
  const agents = new Map([[agent.id, agent]]);
  return new Bridge(
    {
      agents: {
        get: (id) => agents.get(String(id)),
        list: () => [...agents.values()],
      },
      get: () => undefined,
      on: () => {},
      effect: () => () => {},
    },
    { dshHome: '', resultMaxChars: 1000, resultMaxItems: 50 },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
}

test('A13: waitUntilActionRequired observes a running session transition to waiting_for_approval', async () => {
  const mockAgent = {
    id: 's1',
    status: 'running',
    inbox: { nextTurn: [], nextStep: [] },
    session: { events: [], snapshotEvents: () => [], header: { cwd: 'D:/test-workspace' } },
  };
  const bridge = makeBridge(mockAgent);

  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => {
    t += ms;
    bridge.approvals.set('approval-1', {
      id: 'approval-1',
      sessionId: 's1',
      toolName: 'bash',
      resolve() {},
    });
  };

  const result = await bridge.waitUntilActionRequired('s1', 60);
  assert.equal(result.session_id, 's1');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'waiting_for_approval');
  assert.equal(result.approval?.approval_id, 'approval-1');
  assert.equal(t, 500);
});

test('A13: waitUntilActionRequired uses one bounded server-side wait while work remains active', async () => {
  const mockAgent = {
    id: 's2',
    status: 'running',
    inbox: { nextTurn: [], nextStep: [] },
    session: { events: [], snapshotEvents: () => [], header: { cwd: 'D:/test-workspace' } },
  };
  const bridge = makeBridge(mockAgent);
  let t = 0;
  let sleeps = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; sleeps += 1; };

  const result = await bridge.waitUntilActionRequired('s2', 5);
  assert.equal(result.status, 'running');
  assert.equal(result.terminal, false);
  assert.equal(result.continuation_required, true);
  assert.equal(t, 5000);
  assert.equal(sleeps, 10);
});
