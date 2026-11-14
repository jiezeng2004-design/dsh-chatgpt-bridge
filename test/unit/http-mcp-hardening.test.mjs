import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer, TOOL_BEHAVIOR, toolAnnotations } from '../../lib/mcp.js';
import { startHttpServer } from '../../lib/http.js';
import { BridgeError } from '../../lib/bridge.js';
import { isLoopbackOrigin } from '../../lib/config.js';

const TOKEN = 'hardening-test-token';
const warnings = [];
const log = { debug() {}, info() {}, warn: (m) => warnings.push(String(m)), error() {} };
const limits = { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 };

const fakeBridge = {
  async health() { return { ok: true, nested: { api_key: 'sk-abcdefghijklmnop' }, note: 'token=abcd1234efgh' }; },
  async listWorkspaces() { return [{ id: 'w1' }]; },
  async getSession() {
    throw new BridgeError('BAD', 'upstream said api_key=sk-abcdefghijklmnop failed', {
      hint: 'retry with password=hunter2hunter2',
      token: 'supersecret-value',
    });
  },
  async getTaskStatus() { throw new Error('boom Authorization: Bearer abcdefghijklmnopqrstuv'); },
};

const handles = [];
after(async () => {
  for (const h of handles) { try { await h.close(); } catch {} }
});

async function start(authMode = 'token') {
  const handle = await startHttpServer(
    () => createMcpServer(fakeBridge, limits, log),
    { host: '127.0.0.1', port: 0, authMode, authToken: TOKEN },
    log,
  );
  handles.push(handle);
  return handle;
}

const authHeaders = { Authorization: `Bearer ${TOKEN}` };

function rpc(handle, body, headers = {}) {
  return fetch(handle.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...authHeaders,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readRpc(res) {
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(dataLine ? dataLine.slice(5) : text);
}

const initBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

async function initSession(handle, headers = {}) {
  const res = await rpc(handle, initBody, headers);
  assert.equal(res.status, 200);
  const sid = res.headers.get('mcp-session-id');
  assert.ok(sid);
  await res.text();
  const ack = await rpc(handle, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid, ...headers });
  await ack.text();
  return sid;
}

function callTool(handle, sid, name, args = {}) {
  return rpc(handle, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-session-id': sid });
}

function listTools(handle, sid) {
  return rpc(handle, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-session-id': sid });
}

test('isLoopbackOrigin accepts loopback pages only', () => {
  for (const o of ['http://localhost:3000', 'https://127.0.0.1', 'http://127.5.5.5:1', 'http://[::1]:8080', 'http://app.localhost']) {
    assert.equal(isLoopbackOrigin(o), true, o);
  }
  for (const o of ['https://evil.example', 'http://127.0.0.1.evil.example', 'null', '', 'file://', 'http://0.0.0.0', 'http://192.168.1.2', 'not a url']) {
    assert.equal(isLoopbackOrigin(o), false, o);
  }
});

test('forbidden Origin gets 403 on POST, GET and OPTIONS, before auth, with a warning and no ACAO', async () => {
  const handle = await start();
  warnings.length = 0;
  const post = await rpc(handle, initBody, { Origin: 'https://evil.example', Authorization: 'Bearer wrong' });
  assert.equal(post.status, 403);
  assert.deepEqual(await post.json(), { error: 'forbidden-origin' });
  assert.equal(post.headers.get('access-control-allow-origin'), null);
  assert.ok(warnings.some((w) => /forbidden Origin/.test(w) && /evil\.example/.test(w)));

  const get = await fetch(handle.url, { headers: { Origin: 'http://127.0.0.1.evil.example', ...authHeaders } });
  assert.equal(get.status, 403);

  const options = await fetch(handle.url, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(options.status, 403);
  assert.equal(options.headers.get('access-control-allow-origin'), null);

  const opaque = await fetch(handle.url, { method: 'OPTIONS', headers: { Origin: 'null' } });
  assert.equal(opaque.status, 403);
});

test('forbidden Origin cannot drive an authMode none listener', async () => {
  const handle = await start('none');
  const res = await rpc(handle, initBody, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  await res.text();
  const ok = await rpc(handle, initBody);
  assert.equal(ok.status, 200);
  await ok.text();
});

test('loopback Origin is allowed and reflected, never wildcarded', async () => {
  const handle = await start();
  const origin = 'http://localhost:5173';
  const res = await rpc(handle, initBody, { Origin: origin });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.match(res.headers.get('vary') ?? '', /Origin/i);
  await res.text();

  const pre = await fetch(handle.url, { method: 'OPTIONS', headers: { Origin: origin } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), origin);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
});

test('requests without Origin (tunnel traffic) stay allowed and get no ACAO header', async () => {
  const handle = await start();
  const res = await rpc(handle, initBody);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  await res.text();
});

test('invalid JSON body returns HTTP 400 with a JSON-RPC -32700 parse error', async () => {
  const handle = await start();
  const res = await rpc(handle, '{not json');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
  // an existing session also answers 400 on malformed bodies
  const sid = await initSession(handle);
  const bad = await rpc(handle, 'oops', { 'mcp-session-id': sid });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
});

test('tool error results are redacted (BridgeError message/details and INTERNAL message)', async () => {
  const handle = await start();
  const sid = await initSession(handle);

  const bridgeErr = await readRpc(await callTool(handle, sid, 'dsh_get_session', { session_id: 's' }));
  assert.equal(bridgeErr.result.isError, true);
  const text = bridgeErr.result.content[0].text;
  assert.doesNotMatch(text, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(text, /hunter2hunter2/);
  assert.doesNotMatch(text, /supersecret-value/);
  const parsed = JSON.parse(text);
  assert.equal(parsed.error.code, 'BAD');
  assert.match(parsed.error.message, /\[REDACTED\]/);

  const internal = await readRpc(await callTool(handle, sid, 'dsh_get_task_status', { session_id: 's' }));
  assert.equal(internal.result.isError, true);
  const itext = internal.result.content[0].text;
  assert.doesNotMatch(itext, /abcdefghijklmnopqrstuv/);
  assert.equal(JSON.parse(itext).error.code, 'INTERNAL');
});

test('successful object results also carry redacted structuredContent; arrays keep text only', async () => {
  const handle = await start();
  const sid = await initSession(handle);
  const health = await readRpc(await callTool(handle, sid, 'dsh_health'));
  const text = health.result.content[0].text;
  assert.deepEqual(health.result.structuredContent, JSON.parse(text));
  assert.equal(health.result.structuredContent.ok, true);
  assert.doesNotMatch(JSON.stringify(health.result), /sk-abcdefghijklmnop|abcd1234efgh/);

  const list = await readRpc(await callTool(handle, sid, 'dsh_list_workspaces'));
  assert.equal(list.result.structuredContent, undefined);
  assert.deepEqual(JSON.parse(list.result.content[0].text), [{ id: 'w1' }]);
});

const READ_ONLY = [
  'dsh_health', 'dsh_list_workspaces', 'dsh_list_sessions', 'dsh_get_session', 'dsh_get_task_status',
  'dsh_get_result', 'dsh_wait_until_action_required', 'dsh_wait_goal', 'dsh_credential_status',
];
const DESTRUCTIVE = ['dsh_cancel_task', 'dsh_stop_goal', 'dsh_pause_goal', 'dsh_approve', 'dsh_rerun_step'];

test('every registered tool declares annotations matching the central table', () => {
  const server = createMcpServer({}, limits, log);
  const registered = server._registeredTools;
  const names = Object.keys(registered);
  assert.equal(names.length, 23);
  assert.deepEqual([...names].sort(), Object.keys(TOOL_BEHAVIOR).sort());
  for (const name of names) {
    const a = registered[name].annotations;
    assert.ok(a, `${name} missing annotations`);
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof a[key], 'boolean', `${name}.${key}`);
    }
    assert.deepEqual(a, toolAnnotations(name));
  }
  assert.deepEqual(names.filter((n) => registered[n].annotations.readOnlyHint).sort(), [...READ_ONLY].sort());
  assert.deepEqual(names.filter((n) => registered[n].annotations.destructiveHint).sort(), [...DESTRUCTIVE].sort());
  for (const name of READ_ONLY) {
    assert.equal(registered[name].annotations.openWorldHint, false, name);
    assert.equal(registered[name].annotations.destructiveHint, false, name);
  }
});

test('tools/list exposes annotations over the wire', async () => {
  const handle = await start();
  const sid = await initSession(handle);
  const res = await readRpc(await listTools(handle, sid));
  const approve = res.result.tools.find((t) => t.name === 'dsh_approve');
  assert.equal(approve.annotations.destructiveHint, true);
  assert.equal(approve.annotations.readOnlyHint, false);
  const health = res.result.tools.find((t) => t.name === 'dsh_health');
  assert.equal(health.annotations.readOnlyHint, true);
});

test('idle sessions are swept on new-session creation', async () => {
  const handle = await start();
  const realNow = Date.now.bind(Date);
  let offset = 0;
  mock.method(Date, 'now', () => realNow() + offset);
  try {
    const stale = await initSession(handle);
    offset = 31 * 60 * 1000;
    const fresh = await initSession(handle);
    const staleRes = await listTools(handle, stale);
    assert.equal(staleRes.status, 404);
    await staleRes.text();
    const freshRes = await listTools(handle, fresh);
    assert.equal(freshRes.status, 200);
    await freshRes.text();
  } finally {
    mock.restoreAll();
  }
});

test('at capacity the least-recently-active session is evicted, not the oldest inserted', async () => {
  const handle = await start();
  const ids = [];
  for (let i = 0; i < 128; i += 1) ids.push(await initSession(handle));
  await new Promise((r) => setTimeout(r, 15));
  const touch = await listTools(handle, ids[0]);
  assert.equal(touch.status, 200);
  await touch.text();
  const extra = await initSession(handle);

  const first = await listTools(handle, ids[0]);
  assert.equal(first.status, 200, 'recently active first session survives');
  await first.text();
  const second = await listTools(handle, ids[1]);
  assert.equal(second.status, 404, 'least recently active session was evicted');
  await second.text();
  const newest = await listTools(handle, extra);
  assert.equal(newest.status, 200);
  await newest.text();
});
