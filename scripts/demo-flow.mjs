
/**
 * Manual demo: drives the booted DSH bridge over MCP through an analysis turn
 * and follow-ups. Talks to http://127.0.0.1:3456/mcp.
 *
 * Usage: node scripts/demo-flow.mjs [--workspace <id|path|title>]
 * Workspace: pass --workspace or set DSH_BRIDGE_DOGFOOD_WORKSPACE (required; must
 * be a workspace registered with the bridge).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const BASE = 'http://127.0.0.1:3456/mcp';

const wsArg = process.argv.indexOf('--workspace');
const WORKSPACE = (wsArg >= 0 && process.argv[wsArg + 1] ? process.argv[wsArg + 1] : process.env.DSH_BRIDGE_DOGFOOD_WORKSPACE) || '';
if (WORKSPACE === '') {
  console.error('Missing workspace: pass --workspace <id|path|title> or set DSH_BRIDGE_DOGFOOD_WORKSPACE to a registered workspace.');
  process.exit(2);
}
const token = readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'chatgpt-bridge.token'), 'utf8').trim();
const transport = new StreamableHTTPClientTransport(new URL(BASE), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: 'demo-flow', version: '0' });
await client.connect(transport);
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}
let failures = 0;
const check = (name, ok, detail = '') => { console.log((ok ? '  ✔ ' : '  ✖ ') + name + (ok ? '' : ' ' + detail)); if (!ok) failures++; };
async function waitCompleted(sid, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await call('dsh_get_task_status', { session_id: sid });
    if (['completed', 'failed', 'cancelled'].includes(st?.status)) return st;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('timeout');
}
try {
  console.log('[demo] step 1: analyze the project (no modifications)');
  const created = await call('dsh_create_session', {
    workspace: WORKSPACE,
    title: 'bridge-demo-session',
    initial_message: '先检查这个项目（dsh-bridge-demo 子目录），不修改文件。告诉我结构、当前测试和最值得改善的 3 个问题。',
  });
  const sid = created.session_id;
  check('demo session created', typeof sid === 'string' && sid !== '', JSON.stringify(created));
  let st = await waitCompleted(sid);
  check('analysis turn completed', st?.status === 'completed', JSON.stringify(st));
  const r1 = await call('dsh_get_result', { session_id: sid });
  check('analysis result has text', (r1?.assistant_text ?? '').length > 0);
  check('analysis did not modify files (no changed files)', (r1?.changed_files ?? []).length === 0, JSON.stringify(r1?.changed_files));
  console.log('     analysis excerpt:', (r1?.assistant_text ?? '').slice(0, 220).replace(/\n/g, ' | '));

  console.log('[demo] step 2: implement fix on the SAME session');
  const sent = await call('dsh_send_message', {
    session_id: sid,
    message: '第 2 个问题可以，继续这个 Session，实现它并运行已有测试。不要 commit 或 push。',
  });
  check('second message accepted on same session', sent.accepted === true, JSON.stringify(sent));
  st = await waitCompleted(sid);
  check('implementation turn completed', st?.status === 'completed', JSON.stringify(st));
  check('implementation ran as a NEW turn on the same session', (st?.last_turn?.turn ?? 0) >= 2, JSON.stringify(st?.last_turn));
  const r2 = await call('dsh_get_result', { session_id: sid });
  check('implementation result has text', (r2?.assistant_text ?? '').length > 0);
  check('implementation changed files', (r2?.changed_files ?? []).length > 0, JSON.stringify(r2?.changed_files));
  console.log('     changed files:', JSON.stringify(r2?.changed_files));
  console.log('     result excerpt:', (r2?.assistant_text ?? '').slice(0, 220).replace(/\n/g, ' | '));
} finally { await client.close(); }
console.log(failures === 0 ? 'DEMO FLOW PASSED' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
