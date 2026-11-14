import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { Bridge } from '../../lib/bridge.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

test('fallback model matches the official latest base profile', () => {
  const bridge = new Bridge({ get: () => undefined }, {}, log);
  assert.deepEqual(bridge.agentOptions(), { provider: 'deepseek-official', model: 'deepseek-flash' });
});

test('headless overlay only adds workspace, inheriting storage from latest base', () => {
  const overlay = readFileSync(new URL('../../cordis.headless.patch.yml', import.meta.url), 'utf8');
  assert.deepEqual([...overlay.matchAll(/^\s+- id:\s+(\S+)/gm)].map(match => match[1]), ['workspace']);
});

for (const withPreset of [false, true]) {
  test(`setup composes without removed ctx.agent or a bridge-owned model selection (preset=${withPreset})`, async () => {
    const ctx = new Context();
    const mounted = [];
    if (withPreset) ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'test-preset' }),
      mount: async (scope, id) => { mounted.push(id); assert.equal(scope, ctx); },
    });
    const bridge = new Bridge(ctx, {}, log);
    try {
      const composition = await bridge.composeSetupFor(undefined);
      assert.equal(ctx.agent, undefined);
      // DSH 0.2.2 owns model selection on `agent.model` (durable projection);
      // setup only installs the scoped switch-notice listener and takes no Agent.
      assert.equal(composition.setup.length <= 1, true);
      await composition.setup(ctx);
      // The bridge must not rewrite the (deprecated) per-request route itself.
      const request = await ctx.waterfall('agent/request', {}, async () => ({ provider: 'host', model: 'host-model' }));
      assert.deepEqual(request, { provider: 'host', model: 'host-model' });
      assert.deepEqual(mounted, withPreset ? ['test-preset'] : []);
    } finally { await ctx.fiber.dispose(); }
  });
}

test('listSessions reports queued from public Inbox lists without hasPending', async () => {
  const header = { id: 'queued-session', createdAt: 1 };
  const agent = { id: header.id, status: 'idle', inbox: { nextTurn: [{ id: 'message' }], nextStep: [] },
    session: { header, snapshotEvents: () => [] } };
  const services = { agents: { get: () => agent }, sessions: { list: () => [agent.session] } };
  const bridge = new Bridge({ ...services, get: key => services[key] }, {}, log);
  const rows = await bridge.listSessions({});
  assert.equal(rows[0].status, 'queued');
});
