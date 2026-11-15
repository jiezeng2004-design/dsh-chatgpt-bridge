#!/usr/bin/env node
/**
 * Real MCP dogfooding: drives the booted DSH bridge with the official MCP
 * SDK client over Streamable HTTP. Covers the acceptance loop:
 * health -> list workspaces -> create session -> send message -> poll status
 * -> get result -> follow-up -> same session continues (marker memory),
 * plus workspace boundary rejection, session isolation, list/get, long-task
 * running/cancel, and secret redaction.
 *
 * Usage: node scripts/dogfood.mjs [--workspace <id|path|title>]
 * Workspace: pass --workspace <id|path|title> or set DSH_BRIDGE_DOGFOOD_WORKSPACE.
 * Without either, the first registered workspace is used.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.DSH_CHATGPT_BRIDGE_URL ?? 'http://127.0.0.1:3456/mcp';
const TOKEN_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'chatgpt-bridge.token');

function readToken() {
  if (!existsSync(TOKEN_FILE)) return '';
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✖ ${name} ${detail}`);
  }
}

function toolResult(result) {
  const text = result?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n') ?? '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { parsed, isError: result?.isError === true };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return toolResult(result);
}

async function waitFor(client, sessionId, wanted, timeoutMs = 600000, stepMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const { parsed } = await call(client, 'dsh_get_task_status', { session_id: sessionId });
    last = parsed;
    if (wanted.includes(parsed?.status)) return parsed;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`status ${JSON.stringify(last)} never reached ${wanted.join('/')}`);
}

const wsArg = process.argv.indexOf('--workspace');
const workspace = wsArg >= 0 && process.argv[wsArg + 1] ? process.argv[wsArg + 1] : (process.env.DSH_BRIDGE_DOGFOOD_WORKSPACE || undefined);

console.log('dsh-chatgpt-bridge dogfooding');
console.log('target:', BASE);
console.log('token:', readToken() ? '***present***' : '(none)');

const transport = new StreamableHTTPClientTransport(new URL(BASE), {
  requestInit: readToken() ? { headers: { Authorization: `Bearer ${readToken()}` } } : {},
});
const client = new Client({ name: 'dsh-chatgpt-bridge-dogfood', version: '0.1.0' });
await client.connect(transport);

try {
  console.log('\n[1] health');
  const health = await call(client, 'dsh_health');
  check('dsh_health returns ok', health.isError === false && health.parsed?.status === 'ok', JSON.stringify(health.parsed));
  check('no secrets in health output', !JSON.stringify(health.parsed).match(/sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i), '');
  check('bridge version present', typeof health.parsed?.bridge?.version === 'string');
  check('dsh version present', typeof health.parsed?.dsh?.version === 'string');
  console.log('     dsh version:', health.parsed?.dsh?.version, '| sessions:', JSON.stringify(health.parsed?.sessions));

  console.log('\n[2] list workspaces');
  const workspaces = await call(client, 'dsh_list_workspaces');
  check('dsh_list_workspaces ok', workspaces.isError === false && Array.isArray(workspaces.parsed), '');
  console.log('     ' + (workspaces.parsed ?? []).map((w) => `${w.title} (${w.id})`).join(', '));
  const target = workspace ?? workspaces.parsed?.[0]?.title;
  check('at least one registered workspace', workspaces.parsed?.length > 0);
  if (workspaces.parsed?.length === 0) throw new Error('no workspaces - cannot continue');

  console.log('\n[3] create session (workspace boundary first)');
  const rejected = await call(client, 'dsh_create_session', { workspace: 'C:\\Users\\Public' });
  check('unregistered path rejected (Case 5)', rejected.isError === true && rejected.parsed?.error?.code === 'WORKSPACE_NOT_FOUND', JSON.stringify(rejected.parsed));
  const created = await call(client, 'dsh_create_session', {
    workspace: target,
    title: 'bridge-dogfood-A',
    initial_message: 'Remember the marker: ALPHA-731. Reply with exactly: ALPHA-731',
  });
  check('create session accepted', created.isError === false && typeof created.parsed?.session_id === 'string' && created.parsed.session_id !== '', JSON.stringify(created.parsed));
  const sessionA = created.parsed?.session_id;
  check('session bound to a workspace', typeof created.parsed?.workspace === 'string');
  check('created_at present', typeof created.parsed?.created_at === 'string');

  console.log('\n[4] first turn runs to completion');
  await waitFor(client, sessionA, ['completed', 'failed', 'cancelled']);
  const statusA = await call(client, 'dsh_get_task_status', { session_id: sessionA });
  check('first turn completed', statusA.parsed?.status === 'completed', JSON.stringify(statusA.parsed));

  console.log('\n[5] get result');
  const resultA = await call(client, 'dsh_get_result', { session_id: sessionA });
  check('result returns assistant text', typeof resultA.parsed?.assistant_text === 'string' && resultA.parsed.assistant_text.length > 0, '');
  check('result status completed', resultA.parsed?.status === 'completed');
  check('marker remembered in first turn', /ALPHA-731/.test(resultA.parsed?.assistant_text ?? ''), JSON.stringify(resultA.parsed?.assistant_text?.slice(0, 120)));
  console.log('     text:', (resultA.parsed?.assistant_text ?? '').slice(0, 160).replace(/\n/g, ' | '));

  console.log('\n[6] follow-up on the SAME session (Case 3)');
  const sent = await call(client, 'dsh_send_message', { session_id: sessionA, message: 'What marker did I give you? Reply with exactly the marker.' });
  check('follow-up accepted', sent.isError === false && sent.parsed?.accepted === true, JSON.stringify(sent.parsed));
  await waitFor(client, sessionA, ['completed', 'failed', 'cancelled']);
  const resultA2 = await call(client, 'dsh_get_result', { session_id: sessionA });
  check('second turn completed', resultA2.parsed?.status === 'completed', JSON.stringify(resultA2.parsed));
  check('same session remembers ALPHA-731 (Case 3)', /ALPHA-731/.test(resultA2.parsed?.assistant_text ?? ''), JSON.stringify(resultA2.parsed?.assistant_text?.slice(0, 160)));

  console.log('\n[7] session isolation (Case 4)');
  const createdB = await call(client, 'dsh_create_session', {
    workspace: target,
    title: 'bridge-dogfood-B',
    initial_message: 'Remember the marker: BETA-992. Reply with exactly: BETA-992',
  });
  const sessionB = createdB.parsed?.session_id;
  await waitFor(client, sessionB, ['completed', 'failed', 'cancelled']);
  await call(client, 'dsh_send_message', { session_id: sessionA, message: 'Again: what marker did I give you first? Reply with exactly the marker.' });
  await waitFor(client, sessionA, ['completed', 'failed', 'cancelled']);
  const resultA3 = await call(client, 'dsh_get_result', { session_id: sessionA });
  check('session A still says ALPHA-731 (no cross-pollution)', /ALPHA-731/.test(resultA3.parsed?.assistant_text ?? ''), JSON.stringify(resultA3.parsed?.assistant_text?.slice(0, 160)));

  console.log('\n[8] list sessions');
  const list = await call(client, 'dsh_list_sessions', { limit: 20 });
  check('dsh_list_sessions returns rows', list.isError === false && Array.isArray(list.parsed) && list.parsed.length >= 2, JSON.stringify(list.parsed));
  check('session A present in list', list.parsed?.some((s) => s.session_id === sessionA));
  check('list rows carry session_id/title/created_at', list.parsed?.every((s) => s.session_id && s.created_at));

  console.log('\n[9] get session');
  const detail = await call(client, 'dsh_get_session', { session_id: sessionA, max_items: 10, max_chars: 300 });
  check('dsh_get_session ok', detail.isError === false && detail.parsed?.session_id === sessionA, '');
  check('recent messages bounded', Array.isArray(detail.parsed?.messages) && detail.parsed.messages.length <= 10);

  console.log('\n[10] long task running -> cancel (Cases 6+7)');
  const turnBefore = (await call(client, 'dsh_get_task_status', { session_id: sessionB })).parsed?.last_turn?.turn ?? 0;
  await call(client, 'dsh_send_message', {
    session_id: sessionB,
    message: 'Use the pwsh tool to run exactly this command and wait for it: Start-Sleep -Seconds 60; Write-Output done',
  });
  // Deterministic cancel window: as soon as the new turn is OPEN (turn/start
  // logged, no turn/end yet), the driver is working and cancel aborts it.
  let turnOpened = false;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const { parsed } = await call(client, 'dsh_get_task_status', { session_id: sessionB });
    if ((parsed?.last_turn?.turn ?? 0) > turnBefore && parsed?.last_turn?.reason === undefined) {
      turnOpened = true;
      break;
    }
    if ((parsed?.last_turn?.turn ?? 0) > turnBefore && parsed?.last_turn?.reason !== undefined) break; // turn already closed
    await new Promise((r) => setTimeout(r, 250));
  }
  check('long task turn opened and ran (Case 6)', turnOpened);
  // Let the driver settle into the step (the 60s task is still executing),
  // so the cancel lands mid-turn instead of in the pre-step wake window.
  if (turnOpened) await new Promise((r) => setTimeout(r, 4000));
  const cancel = await call(client, 'dsh_cancel_task', { session_id: sessionB });
  check('cancel accepted', cancel.isError === false && cancel.parsed?.cancelled === true, JSON.stringify(cancel.parsed));
  await waitFor(client, sessionB, ['cancelled', 'completed', 'failed'], 120000);
  const statusB = await call(client, 'dsh_get_task_status', { session_id: sessionB });
  check('cancelled turn reported cancelled (Case 7)', statusB.parsed?.status === 'cancelled', JSON.stringify(statusB.parsed));

  console.log('\n[11] secret redaction in tool outputs (Case 8)');
  const health2 = await call(client, 'dsh_health', {});
  const healthText = JSON.stringify(health2.parsed);
  check('no sk- keys in health', !/sk-[A-Za-z0-9]{8,}/.test(healthText));
  check('no bearer tokens in health', !/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(healthText));
  check('health never reports the token itself', !healthText.includes(readToken()) || readToken() === '');
  check('goalSupervision capability', health2.parsed?.capabilities?.goalSupervision === true);

  console.log('\n[12] Goal Supervision loop');
  const requestId = `dogfood-goal-${Date.now()}`;
  const goalArgs = {
    workspace: target,
    goal: 'Reply with exactly GOAL-OK and stop. Do not modify files.',
    plan: '1. Acknowledge\n2. Reply GOAL-OK\n3. Stop',
    request_id: requestId,
  };
  const started = await call(client, 'dsh_start_goal', goalArgs);
  check('dsh_start_goal accepted', started.isError === false && typeof started.parsed?.session_id === 'string', JSON.stringify(started.parsed));
  check('start continuation_required', started.parsed?.continuation_required === true, JSON.stringify(started.parsed));
  check('start next_tool_call is dsh_wait_goal', started.parsed?.next_tool_call?.name === 'dsh_wait_goal');
  const goalSession = started.parsed?.session_id;
  const retrySame = await call(client, 'dsh_start_goal', goalArgs);
  check('request_id retry reuses session', retrySame.isError === false && retrySame.parsed?.session_id === goalSession, JSON.stringify(retrySame.parsed));

  let lastWait;
  const goalDeadline = Date.now() + 600000;
  while (Date.now() < goalDeadline) {
    lastWait = await call(client, 'dsh_wait_goal', { session_id: goalSession, wait_seconds: 25 });
    check('wait_goal call ok', lastWait.isError === false, JSON.stringify(lastWait.parsed));
    if (lastWait.parsed?.continuation_required !== true) break;
  }
  check('goal reached a non-continuing state', lastWait?.parsed?.continuation_required === false, JSON.stringify(lastWait?.parsed));
  if (lastWait?.parsed?.status === 'completed') {
    check('completed goal is terminal', lastWait.parsed.terminal === true);
    check('completed goal includes result summary', typeof lastWait.parsed.result?.summary === 'string');
  }

  console.log('\n[13] dsh_stop_goal idempotent');
  const stop1 = await call(client, 'dsh_stop_goal', { session_id: goalSession });
  check('stop accepted', stop1.isError === false && stop1.parsed?.stopped === true, JSON.stringify(stop1.parsed));
  const stop2 = await call(client, 'dsh_stop_goal', { session_id: goalSession });
  check('second stop already_stopped', stop2.isError === false && stop2.parsed?.already_stopped === true, JSON.stringify(stop2.parsed));

  if (health2.parsed?.capabilities?.webSurface === true) {
    console.log('\n[14] Web session.list parity (same runtime)');
    try {
      const listed = await fetch('http://127.0.0.1:3080/api/session.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session.list',
          payload: {},
        }),
      });
      const body = await listed.json();
      const items = body?.result?.value?.items ?? body?.items ?? [];
      const ids = items.map((item) => item.sessionId ?? item.session_id);
      check('ChatGPT session visible in DSH Web session.list', ids.includes(goalSession), JSON.stringify(ids.slice(0, 8)));
    } catch (error) {
      check('ChatGPT session visible in DSH Web session.list', false, String(error));
    }
  } else {
    check('webSurface is true (same runtime as DSH Web :3080)', false, 'boot --profile web with this plugin; do not use a separate chatgpt-bridge process');
  }
} finally {
  await client.close();
}

console.log('\n==== dogfood summary ====');
if (failures === 0) console.log('ALL CHECKS PASSED');
else console.log(`${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);