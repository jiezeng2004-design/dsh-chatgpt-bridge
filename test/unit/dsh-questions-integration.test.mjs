import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import UserQuestions from '@deepseek-ai/dsh-user-questions';
import { Bridge } from '../../lib/bridge.js';

test('real DSH question waterfall reaches the bridge and abort clears its pending request', { timeout: 5000 }, async () => {
  const ctx = new Context();
  await ctx.plugin(UserQuestions);
  const fallback = { answers: [] };
  ctx.on('user-questions/request', async () => fallback);
  const bridge = new Bridge(ctx, {}, { info() {}, warn() {}, error() {}, debug() {} });
  bridge.start();
  try {
    const controller = new AbortController();
    const asking = ctx.userQuestions.ask({
      questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }],
      signal: controller.signal,
    });
    // Attach rejection handling immediately: the real service owns abort errors.
    const settled = asking.then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridge['questions'].size, 1);
    controller.abort();
    await settled;
    assert.equal(bridge['questions'].size, 0);
    // Dispatch directly to test routing without fabricating a live DSH agent.
    assert.equal(await ctx.waterfall('user-questions/request', {
      agent: { id: 'unmanaged' }, questions: [],
    }, async () => fallback), fallback);

    const answer = { answers: [{ id: 'q', selected: ['Yes'] }] };
    const next = ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] });
    await new Promise(resolve => setImmediate(resolve));
    const pending = [...bridge['questions'].values()][0];
    assert.ok(pending);
    pending.resolve(answer);
    assert.deepEqual(await next, answer);
    assert.equal(bridge['questions'].size, 0);
  } finally {
    await ctx.fiber.dispose();
  }
});
