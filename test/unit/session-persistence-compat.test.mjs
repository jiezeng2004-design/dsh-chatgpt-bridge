import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPersistedSession, persistedHeader, sessionEvents } from '../../lib/session-persistence-compat.js';
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry';

test('0.1.3 persistence reads without write ownership and closes before returning', async () => {
  const calls = [];
  const header = { id: 'session-a' };
  const events = [{ type: 'test' }];
  const result = await inspectPersistedSession({
    async open(id, access) {
      calls.push([id, access]);
      return { header, async read() { calls.push('read'); return events; }, async close() { calls.push('close'); } };
    },
    async inspect() { assert.fail('must use the current API'); },
  }, 'session-a');
  assert.deepEqual(result, { meta: header, events });
  assert.deepEqual(calls, [['session-a', 'read'], 'read', 'close']);
});

test('0.1.3 persistence closes read handles when reading fails', async () => {
  let closed = false;
  const failure = new Error('read failed');
  await assert.rejects(inspectPersistedSession({ async open() {
    return { header: {}, async read() { throw failure; }, async close() { closed = true; } };
  } }, 'session-a'), error => error === failure);
  assert.equal(closed, true);
});

test('V3 persistence unwraps the read envelope and releases only a read handle', async () => {
  const header = { id: 'v3-session' };
  const events = Object.freeze([{ type: 'test' }]);
  const calls = [];
  const result = await inspectPersistedSession({ async open(id, access) {
    calls.push([id, access]);
    return { header, async read() { return { eventState: 'shared-frozen', events }; },
      async close() { calls.push('close'); } };
  } }, header.id);
  assert.deepEqual(result, { meta: header, events });
  assert.equal(result.events, events);
  assert.deepEqual(calls, [[header.id, 'read'], 'close']);
});

test('malformed V3 read envelopes fail closed and still release their handle', async () => {
  let closed = false;
  await assert.rejects(inspectPersistedSession({ async open() {
    return { header: {}, async read() { return { events: {} }; },
      async close() { closed = true; } };
  } }, 'invalid'), /Unsupported DSH session read result/);
  assert.equal(closed, true);
});

test('legacy inspect and both list metadata shapes remain supported', async () => {
  const header = { id: 'session-a' };
  const inspection = { meta: header, events: [] };
  assert.equal(await inspectPersistedSession({ async inspect(id) { assert.equal(id, header.id); return inspection; } }, header.id), inspection);
  assert.equal(persistedHeader(header), header);
  assert.equal(persistedHeader({ header, revision: 'opaque' }), header);
  await assert.rejects(inspectPersistedSession({}, header.id), /Unsupported/);
});

test('live snapshot API takes precedence and preset replay preserves later selections', () => {
  const events = [{ type: 'agent-preset/selected', data: { agentPreset: 'new-preset' } }];
  assert.equal(sessionEvents({ snapshotEvents: () => events, events: [] }), events);
  assert.equal(sessionEvents({ events }), events);
  assert.throws(() => sessionEvents({}), /Unsupported/);
  assert.equal(events.reduce(agentPresetProjectionDefinition.apply,
    agentPresetProjectionDefinition.init({ agentPreset: 'old-preset' })), 'new-preset');
});
