#!/usr/bin/env node
/**
 * Cross-restart continuation test: creates a marker session through MCP,
 * restarts the DSH profile process, then continues the SAME DSH session and
 * verifies the marker survives. This is the "tomorrow's ChatGPT conversation
 * continues today's DSH session" guarantee at the DSH level.
 *
 * The restart is performed by this script via child_process (the profile's
 * process is matched by its command line). Requires the bridge profile to be
 * running and a token file at $DSH_HOME/chatgpt-bridge.token.
 *
 * Workspace: pass --workspace <id|path|title> or set DSH_BRIDGE_DOGFOOD_WORKSPACE
 * (required; must be a workspace registered with the bridge).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.DSH_CHATGPT_BRIDGE_URL ?? 'http://127.0.0.1:3456/mcp';
const TOKEN_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'chatgpt-bridge.token');
const PROFILE = process.env.DSH_CHATGPT_BRIDGE_PROFILE ?? 'chatgpt-bridge';
const WORKDIR = process.env.DSH_CHATGPT_BRIDGE_WORKDIR ?? process.cwd();
const LOG = process.env.DSH_CHATGPT_BRIDGE_BOOTLOG ?? join(process.cwd(), 'boot-console.log');

const wsArg = process.argv.indexOf('--workspace');
const WORKSPACE = (wsArg >= 0 && process.argv[wsArg + 1] ? process.argv[wsArg + 1] : process.env.DSH_BRIDGE_DOGFOOD_WORKSPACE) || '';
if (WORKSPACE === '') {
  console.error('Missing workspace: pass --workspace <id|path|title> or set DSH_BRIDGE_DOGFOOD_WORKSPACE to a registered workspace.');
  process.exit(2);
}

function readToken() {
  return existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '';
}
let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  ✔ ' : '  ✖ ') + name + (ok ? '' : ' ' + detail));
  if (!ok) failures++;
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: readToken() ? { headers: { Authorization: `Bearer ${readToken()}` } } : {},
  });
  const client = new Client({ name: 'resume-test', version: '0.1.0' });
  await client.connect(transport);
  return { client, transport };
}
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}
async function waitCompleted(client, sid, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await call(client, 'dsh_get_task_status', { session_id: sid });
    if (['completed', 'failed', 'cancelled'].includes(st?.status)) return st;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('status never reached a terminal state');
}
function restartProfile() {
  // Kill the running profile process and boot it again (best-effort; requires
  // the dsh CLI on PATH). On Windows, match node processes by command line.
  const killScript = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  execFileSync('powershell', ['-NoProfile', '-Command', killScript], { stdio: 'ignore' });
  return new Promise((resolve) => {
    const { spawn } = import('node:child_process');
    spawn('dsh', ['--profile', PROFILE], { cwd: WORKDIR, stdio: 'ignore', detached: true }).unref();
    resolve();
  });
}
async function waitForEndpoint(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { client } = await connect();
      await call(client, 'dsh_health', {});
      await client.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

let sid;
console.log('phase 1: create a marker session');
{
  const { client } = await connect();
  try {
    const created = await call(client, 'dsh_create_session', {
      workspace: WORKSPACE,
      title: 'RESUME-TEST-731',
      initial_message: 'Remember the marker: ALPHA-731. Reply with exactly: ALPHA-731',
    });
    sid = created.session_id;
    check('session created', typeof sid === 'string' && sid !== '');
    const st = await waitCompleted(client, sid);
    check('phase-1 turn completed', st?.status === 'completed', JSON.stringify(st));
  } finally {
    await client.close();
  }
}

console.log('restarting profile process...');
restartProfile();
const up = await waitForEndpoint();
check('profile back up after restart', up);
if (!up) process.exit(1);

console.log('phase 2: continue the SAME session after the restart');
{
  const { client } = await connect();
  try {
    const before = await call(client, 'dsh_get_task_status', { session_id: sid });
    check('session is cold (not live) after restart', before.live === false, JSON.stringify(before));
    const sent = await call(client, 'dsh_send_message', { session_id: sid, message: 'What marker did I give you? Reply with exactly the marker.' });
    check('message accepted on resumed session', sent.accepted === true, JSON.stringify(sent));
    const st = await waitCompleted(client, sid);
    check('resumed turn completed', st?.status === 'completed', JSON.stringify(st));
    check('resume created a NEW turn (turn > 1)', (st?.last_turn?.turn ?? 0) > 1, JSON.stringify(st?.last_turn));
    const result = await call(client, 'dsh_get_result', { session_id: sid });
    check('marker remembered after restart (same DSH session continued)', /ALPHA-731/.test(result?.assistant_text ?? ''), JSON.stringify(result?.assistant_text?.slice(0, 160)));
    console.log('     text:', (result?.assistant_text ?? '').slice(0, 160).replace(/\n/g, ' | '));
  } finally {
    await client.close();
  }
}

console.log(failures === 0 ? 'RESUME TEST PASSED' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
