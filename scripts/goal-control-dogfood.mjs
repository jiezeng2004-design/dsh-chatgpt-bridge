#!/usr/bin/env node
/**
 * Real MCP dogfood for the v0.6.0 compatibility release candidate.
 *
 * Dogfood A — minimal 35-second Goal (no workspace scan, no file writes).
 * Dogfood B — mock release DAG: block one branch, defer it, finish the
 *             independent branch, then resume. No real npm publish.
 *
 * Usage: node scripts/goal-control-dogfood.mjs [--workspace <id|path|title>]
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

async function waitLoop(client, sessionId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let polls = 0;
  while (Date.now() < deadline) {
    const { parsed, isError } = await call(client, 'dsh_wait_until_action_required', { session_id: sessionId, wait_seconds: 120 });
    last = parsed;
    polls += 1;
    if (isError) throw new Error(`dsh_wait_until_action_required error: ${JSON.stringify(parsed)}`);
    if (parsed?.needs_user_action) return parsed;
    if (parsed?.terminal) return parsed;
    if (parsed?.continuation_required) continue;
    return parsed;
  }
  throw new Error(`wait loop timed out after ${polls} polls: ${JSON.stringify(last)}`);
}

const wsArg = process.argv.indexOf('--workspace');
const workspace = wsArg >= 0 && process.argv[wsArg + 1] ? process.argv[wsArg + 1] : undefined;

console.log('dsh-chatgpt-bridge goal-control dogfood');
console.log('target:', BASE);

const transport = new StreamableHTTPClientTransport(new URL(BASE), {
  requestInit: readToken() ? { headers: { Authorization: `Bearer ${readToken()}` } } : {},
});
const client = new Client({ name: 'dsh-chatgpt-bridge-goal-dogfood', version: '0.6.0' });

try {
  await client.connect(transport);

  console.log('\n[1] health + capabilities');
  const health = await call(client, 'dsh_health');
  check('health status ok', health.isError === false && health.parsed?.status === 'ok', JSON.stringify(health.parsed));
  check('version 0.6.0', health.parsed?.bridge?.version === '0.6.0', String(health.parsed?.bridge?.version));

  const listed = await call(client, 'dsh_list_workspaces');
  const workspaces = listed.parsed?.workspaces ?? listed.parsed ?? [];
  const rows = Array.isArray(workspaces) ? workspaces : [];
  const picked = workspace
    ?? rows[0]?.id
    ?? rows[0]?.path
    ?? rows[0]?.title;
  check('have a workspace', typeof picked === 'string' && picked !== '', JSON.stringify(rows.slice(0, 2)));
  if (typeof picked !== 'string') throw new Error('no registered workspace');

  console.log('\n[A] minimal 35-second Goal');
  const startA = await call(client, 'dsh_create_goal', {
    workspace: picked,
    goal: '只等待 35 秒然后完成。禁止扫描 workspace。禁止修改文件。不要创建报告。',
    execution_mode: 'minimal',
    constraints: { allow_workspace_scan: false, max_changed_files: 0, read_only: true },
  });
  check('start_goal ok', startA.isError === false, JSON.stringify(startA.parsed));
  const sessionA = startA.parsed?.session_id;
  check('revision 1', startA.parsed?.goal?.revision === 1, JSON.stringify(startA.parsed?.goal));
  check('mode minimal', startA.parsed?.goal?.mode === 'minimal', String(startA.parsed?.goal?.mode));

  const firstWait = await call(client, 'dsh_wait_until_action_required', { session_id: sessionA, wait_seconds: 60 });
  check('first action-required wait returned', firstWait.isError === false, JSON.stringify(firstWait.parsed?.status));
  const doneA = firstWait.parsed?.terminal
    ? firstWait.parsed
    : await waitLoop(client, sessionA);
  check('minimal goal completed', doneA?.status === 'completed', JSON.stringify({ status: doneA?.status, next: doneA?.next_action }));
  const filesA = doneA?.result?.changed_files ?? doneA?.progress?.changed_files ?? [];
  check('0 changed files', Array.isArray(filesA) && filesA.length === 0, JSON.stringify(filesA));
  const dumpA = JSON.stringify(doneA);
  check('no recursive workspace listing in wait payload', !/169708|Get-ChildItem -Recurse/i.test(dumpA), '');

  console.log('\n[B] defer / independent branch / resume (mock release, no publish)');
  const startB = await call(client, 'dsh_create_goal', {
    workspace: picked,
    goal: [
      'Mock a release-shaped plan without publishing or pushing.',
      'Steps: (A) write a single line to a temp note if needed, then (B) pretend npm publish is blocked, (C) finish an independent "GitHub Release" checklist item as a no-op echo.',
      'Do not run npm publish. Do not git push. Do not git tag.',
    ].join('\n'),
    plan: '1. echo step A\n2. npm publish\n3. GitHub Release',
    execution_mode: 'strict',
    constraints: { allow_workspace_scan: false },
  });
  check('start_goal B ok', startB.isError === false, JSON.stringify(startB.parsed));
  const sessionB = startB.parsed?.session_id;
  check('B same-process new session', sessionB !== sessionA, `${sessionA} vs ${sessionB}`);
  check('B revision 1', startB.parsed?.goal?.revision === 1);

  await waitLoop(client, sessionB, 120000);

  const deferred = await call(client, 'dsh_update_goal', {
    session_id: sessionB,
    action: 'defer',
    defer_steps: ['npm_publish'],
    revision_reason: 'npm 暂缓，其他继续',
  });
  check('update defer ok', deferred.isError === false, JSON.stringify(deferred.parsed));
  check('same session', deferred.parsed?.session_id === sessionB, String(deferred.parsed?.session_id));
  check('revision +1', deferred.parsed?.goal?.revision === 2, JSON.stringify(deferred.parsed?.goal));
  check('same goal_id', deferred.parsed?.goal?.goal_id === startB.parsed?.goal?.goal_id);

  const afterDefer = deferred.parsed?.continuation_required
    ? await waitLoop(client, sessionB, 120000)
    : deferred.parsed;
  check('independent branch not frozen', afterDefer?.status !== 'failed', JSON.stringify({ status: afterDefer?.status, deferred: afterDefer?.deferred_steps ?? afterDefer?.execution?.deferred_steps }));

  const resumed = await call(client, 'dsh_update_goal', {
    session_id: sessionB,
    action: 'resume',
    resume_steps: ['npm_publish'],
    revision_reason: '继续 npm（mock，不要真 publish）',
    goal: 'Resume the deferred npm step as a no-op. Do not run npm publish. Echo that npm is still deferred-safe mock.',
  });
  check('resume ok', resumed.isError === false, JSON.stringify(resumed.parsed));
  check('resume same session', resumed.parsed?.session_id === sessionB);
  check('resume revision +1', (resumed.parsed?.goal?.revision ?? 0) >= 3, JSON.stringify(resumed.parsed?.goal));
  check('resume same goal_id', resumed.parsed?.goal?.goal_id === startB.parsed?.goal?.goal_id);

  await call(client, 'dsh_stop_goal', { session_id: sessionA });
  await call(client, 'dsh_stop_goal', { session_id: sessionB });
} catch (error) {
  failures++;
  console.error('dogfood failed:', error instanceof Error ? error.message : error);
} finally {
  try { await client.close(); } catch { /* ignore */ }
}

console.log(failures === 0 ? '\ngoal-control dogfood passed' : `\ngoal-control dogfood failed (${failures})`);
process.exit(failures === 0 ? 0 : 1);
