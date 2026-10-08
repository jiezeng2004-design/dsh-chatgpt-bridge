// Run in a disposable copy with @deepseek-ai/dsh@0.2.0-rc.2 installed.
// Real Cordis, AgentLoop, V3 JSONL, approvals and questions; no credentials or model adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Llm from '@deepseek-ai/dsh-llm';
import Questions from '@deepseek-ai/dsh-user-questions';
import Approval from '@deepseek-ai/dsh-user-approval';
import Title from '@deepseek-ai/dsh-session-title';
import { Bridge } from '../../lib/bridge.js';

test('real DSH: explicit setup, V3 read/cold resume, question/approval and teardown', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-dsh-contract-'));
  const ctx = new Context();
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  let handle;
  try {
    for (const plugin of [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Questions, Approval]) {
      await ctx.plugin(plugin, {});
    }
    await ctx.plugin(Title, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 });
    await ctx.plugin(Persistence, { root: join(home, 'sessions') });
    await ctx.plugin(AgentLoop, {});
    const bridge = new Bridge(ctx, { dshHome: home, sessionMaxItems: 10, sessionMaxChars: 500 }, log);
    bridge.start();
    const setup = await bridge.composeSetupFor(undefined);
    handle = await ctx.agents.create({ sessionId: SessionId('bridge-contract'), meta: { cwd: home }, setup: setup.setup });
    const { agent } = handle;
    bridge.adopt(agent.id);
    assert.equal((await bridge.getSession(agent.id)).status, 'idle');
    const asking = ctx.userQuestions.ask({ agent, questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] });
    await new Promise(resolve => setImmediate(resolve));
    const question = [...bridge.questions.values()][0];
    assert.ok(question);
    await bridge.answerQuestion(question.id, agent.id, { selected: ['Yes'] });
    assert.deepEqual(await asking, { answers: [{ id: 'q', selected: ['Yes'] }] });

    agent.session.append('turn/start', { turn: 1 });
    // Exercise real ApprovalService normalization: "approved" becomes unavailable.
    assert.equal(await ctx.approval.request({ agent, toolName: 'read' }), 'allowed-once');
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await ctx.sessionPersistence.flush();
    await handle.dispose();
    handle = undefined;
    assert.equal(ctx.agents.get(agent.id), undefined);
    const cold = await bridge.getSession(agent.id);
    assert.equal(cold.status, 'completed');
    assert.equal((await bridge.listSessions({}))[0].session_id, agent.id);
    const resumed = await bridge.ensureAgent(agent.id);
    assert.equal(resumed.id, agent.id);
    assert.equal((await bridge.getSession(agent.id)).status, 'completed');
    const approval = resumed.session.snapshotEvents().find(event => event.type === 'approval/decided');
    assert.equal(approval.data.outcome, 'allowed-once');
  } finally {
    if (handle) await handle.dispose();
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
