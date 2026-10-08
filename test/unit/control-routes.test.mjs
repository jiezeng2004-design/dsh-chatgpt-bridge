import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { RuntimeManager } from '../../lib/control/runtime-manager.js';
import { FakeTunnelRuntime } from '../../lib/control/fake-tunnel-runtime.js';
import { createManagementApi, MUTATION_HEADER } from '../../lib/control/routes.js';

const created = [];
after(async () => {
  for (const { server } of created) {
    try { await new Promise((resolve) => server.close(resolve)); } catch {}
  }
  for (const tmp of created.map((c) => c.tmp).filter((t) => t !== undefined)) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function startFakeBridge() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.statusCode = req.headers.authorization === 'Bearer test-token' ? 400 : 401;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      created.push({ server });
      resolve(server);
    });
  });
}

async function setup() {
  const tmp = mkdtempSync(join(process.cwd(), '.ctrl-routes-'));
  const bridge = await startFakeBridge();
  const fake = new FakeTunnelRuntime({ script: {} });
  const manager = new RuntimeManager({
    dshHome: tmp,
    bridge: { url: `http://127.0.0.1:${bridge.address().port}/mcp`, token: 'test-token', authMode: 'token' },
    createRuntime: () => fake,
    pollIntervalMs: 100,
    discover: () => ({}),
  });
  manager.secretStore.writeRuntimeApiKey('sk-super-secret-1234567890');
  await manager.saveConfig({
    tunnel: { tunnelId: 'tunnel_test', autoStart: false, proxy: { enabled: false } },
    openai: { controlPlaneBaseUrl: `http://127.0.0.1:${bridge.address().port}` },
  });
  const api = createManagementApi(manager, { dshHome: tmp });
  let captured;
  const disposer = api.register({ register: (route) => { captured = route; return () => {}; } });
  created.push({ server: { close: (cb) => cb() }, tmp });
  return { tmp, manager, api, getRoute: () => captured };
}

function makeReq({ method = 'GET', url = '/', headers = { host: '127.0.0.1:3080' }, remoteAddress = '127.0.0.1', body }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  }
  return req;
}

function makeRes() {
  const res = { statusCode: 0, body: '', headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (s) => { res.body = s; };
  return res;
}

const validMutation = (url, body) => ({
  method: 'POST',
  url,
  headers: {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'content-type': 'application/json',
    [MUTATION_HEADER]: '1',
  },
  body: body ?? '{}',
});

async function call(route, req, res) {
  await route.handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

test('routes: GET /status from loopback is allowed', async () => {
  const { getRoute } = await setup();
  const res = await call(getRoute(), makeReq({ url: '/_dsh/chatgpt-bridge/status' }), makeRes());
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('"ok":true'));
});

test('routes: remote address denied', async () => {
  const { getRoute } = await setup();
  const res = await call(getRoute(), makeReq({ url: '/_dsh/chatgpt-bridge/status', remoteAddress: '10.0.0.1' }), makeRes());
  assert.equal(res.statusCode, 403);
});

test('routes: bad Host denied', async () => {
  const { getRoute } = await setup();
  const base = validMutation('/_dsh/chatgpt-bridge/start');
  const req = makeReq({ ...base, headers: { ...base.headers, host: 'evil.example' } });
  const res = await call(getRoute(), req, makeRes());
  assert.equal(res.statusCode, 403);
});

test('routes: bad Origin denied (CSRF)', async () => {
  const { getRoute } = await setup();
  const req = makeReq({
    ...validMutation('/_dsh/chatgpt-bridge/start'),
    headers: { ...validMutation('/_dsh/chatgpt-bridge/start').headers, origin: 'http://evil.example' },
  });
  const res = await call(getRoute(), req, makeRes());
  assert.equal(res.statusCode, 403);
  assert.ok(res.body.includes('bad-origin'));
});

test('routes: missing custom header denied', async () => {
  const { getRoute } = await setup();
  const req = makeReq({
    ...validMutation('/_dsh/chatgpt-bridge/start'),
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
  });
  const res = await call(getRoute(), req, makeRes());
  assert.equal(res.statusCode, 403);
  assert.ok(res.body.includes('bad-header'));
});

test('routes: bad content-type denied', async () => {
  const { getRoute } = await setup();
  const req = makeReq({
    ...validMutation('/_dsh/chatgpt-bridge/start'),
    headers: { ...validMutation('/_dsh/chatgpt-bridge/start').headers, 'content-type': 'text/plain' },
  });
  const res = await call(getRoute(), req, makeRes());
  assert.equal(res.statusCode, 415);
});

test('routes: valid start mutation is allowed', async () => {
  const { getRoute } = await setup();
  const req = makeReq(validMutation('/_dsh/chatgpt-bridge/start'));
  const res = await call(getRoute(), req, makeRes());
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('"ok":true'));
});

test('routes: IPv6 loopback Host and Origin are allowed but wildcard IPv6 Origin is denied', async () => {
  const { getRoute } = await setup();
  const ipv6 = validMutation('/_dsh/chatgpt-bridge/start');
  ipv6.headers = { ...ipv6.headers, host: '[::1]:3080', origin: 'http://[::1]:3080' };
  const allowed = await call(getRoute(), makeReq({ ...ipv6, remoteAddress: '::1' }), makeRes());
  assert.equal(allowed.statusCode, 200);

  const wildcard = validMutation('/_dsh/chatgpt-bridge/start');
  wildcard.headers = { ...wildcard.headers, host: '[::1]:3080', origin: 'http://[::]:3080' };
  const denied = await call(getRoute(), makeReq({ ...wildcard, remoteAddress: '::1' }), makeRes());
  assert.equal(denied.statusCode, 403);
  assert.ok(denied.body.includes('bad-origin'));
});

test('routes: GET /config includes discovered hints and never leaks profile secrets', async () => {
  const tmp = mkdtempSync(join(process.cwd(), '.ctrl-routes-'));
  const bridge = await startFakeBridge();
  const fake = new FakeTunnelRuntime({ script: { installed: true } });
  const manager = new RuntimeManager({
    dshHome: tmp,
    bridge: { url: `http://127.0.0.1:${bridge.address().port}/mcp`, token: 'test-token', authMode: 'token' },
    createRuntime: () => fake,
    pollIntervalMs: 100,
    discover: () => ({
      executable: { path: 'D:\\\\Application\\\\tunnel-client\\\\tunnel-client.exe', source: 'well-known' },
      tunnelId: 'tunnel_discovered_from_profile',
      controlPlaneBaseUrl: 'https://api.openai.com',
      runtimeApiKeyAvailable: true,
    }),
  });
  const api = createManagementApi(manager, { dshHome: tmp });
  let captured;
  api.register({ register: (route) => { captured = route; return () => {}; } });
  created.push({ server: { close: (cb) => cb() }, tmp });
  const res = await call(captured, makeReq({ url: '/_dsh/chatgpt-bridge/config' }), makeRes());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.discovered.tunnelId, 'tunnel_discovered_from_profile');
  assert.equal(body.discovered.executable.source, 'well-known');
  assert.equal(body.discovered.runtimeApiKeyAvailable, true);
  assert.ok(!res.body.includes('sk-'), 'discovered must not carry a literal key');
  assert.ok(!Object.prototype.hasOwnProperty.call(body.discovered, 'apiKey'));
  assert.ok(!Object.prototype.hasOwnProperty.call(body.discovered, 'api_key'));
});

test('routes: settings save can clear Tunnel ID while malformed nonempty IDs remain denied', async () => {
  const { manager, getRoute } = await setup();
  const form = {
    tunnel: { tunnelId: '', autoStart: false, executable: '', proxy: { enabled: true, host: '127.0.0.1', port: 7892 } },
    openai: { controlPlaneBaseUrl: '' },
  };
  const saved = await call(getRoute(), makeReq({
    ...validMutation('/_dsh/chatgpt-bridge/config', JSON.stringify(form)), method: 'PUT',
  }), makeRes());
  assert.equal(saved.statusCode, 200);
  assert.equal(JSON.parse(saved.body).ok, true);
  assert.equal(manager.getConfig().tunnel.tunnelId, '');
  assert.equal(manager.getConfig().tunnel.autoStart, false);
  assert.deepEqual(manager.getConfig().tunnel.proxy, { enabled: true, host: '127.0.0.1', port: 7892 });
  assert.equal(manager.getConfig().openai.controlPlaneBaseUrl, undefined);
  for (const tunnelId of [' ', '../tunnel', 'tunnel\ninvalid']) {
    const rejected = await call(getRoute(), makeReq({
      ...validMutation('/_dsh/chatgpt-bridge/config', JSON.stringify({ tunnel: { tunnelId } })), method: 'PUT',
    }), makeRes());
    assert.equal(rejected.statusCode, 400);
    assert.equal(JSON.parse(rejected.body).error, 'invalid-identifier');
    assert.equal(manager.getConfig().tunnel.tunnelId, '');
  }
});

test('routes: GET /config never leaks the key value', async () => {
  const { getRoute } = await setup();
  const res = await call(getRoute(), makeReq({ url: '/_dsh/chatgpt-bridge/config' }), makeRes());
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('"runtimeApiKeyConfigured":true'));
  assert.ok(!res.body.includes('sk-super-secret-1234567890'), 'key value must not appear');
});

test('routes: GET /logs redacts secrets', async () => {
  const { tmp, getRoute } = await setup();
  mkdirSync(join(tmp, 'chatgpt-bridge', 'logs'), { recursive: true });
  writeFileSync(join(tmp, 'chatgpt-bridge', 'logs', 'manager.ndjson'), '{"time":"x","level":"info","message":"key sk-test-9999-abcdefgh and Bearer abcdefghijklmnop leaked?"}\n', 'utf8');
  const res = await call(getRoute(), makeReq({ url: '/_dsh/chatgpt-bridge/logs?component=manager' }), makeRes());
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('sk-test-9999'), 'sk- must be redacted');
  assert.ok(!res.body.includes('abcdefghijklmnop'), 'bearer must be redacted');
  assert.ok(res.body.includes('[REDACTED]'));
});

test('routes: unknown route returns 404', async () => {
  const { getRoute } = await setup();
  const res = await call(getRoute(), makeReq({ url: '/_dsh/chatgpt-bridge/nope' }), makeRes());
  assert.equal(res.statusCode, 404);
});

test('routes: diagnostics status() throw returns structured status-failed, not 500', async () => {
  const tmp = mkdtempSync(join(process.cwd(), '.ctrl-routes-'));
  const bridge = await startFakeBridge();
  const fake = new FakeTunnelRuntime({ script: { healthOk: true, readyOk: true } });
  const manager = new RuntimeManager({
    dshHome: tmp,
    bridge: { url: `http://127.0.0.1:${bridge.address().port}/mcp`, token: 'test-token', authMode: 'token' },
    createRuntime: () => fake,
    pollIntervalMs: 100,
    discover: () => ({}),
  });
  manager.secretStore.writeRuntimeApiKey('sk-super-secret-1234567890');
  await manager.saveConfig({
    tunnel: { tunnelId: 'tunnel_test', autoStart: false, proxy: { enabled: false } },
    openai: { controlPlaneBaseUrl: `http://127.0.0.1:${bridge.address().port}` },
  });
  await manager.start();
  fake.setStatusError(new Error('status exploded'));
  const api = createManagementApi(manager, { dshHome: tmp });
  let captured;
  api.register({ register: (route) => { captured = route; return () => {}; } });
  created.push({ server: { close: (cb) => cb() }, tmp });
  const res = await call(captured, makeReq(validMutation('/_dsh/chatgpt-bridge/diagnostics')), makeRes());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  const statusStep = (body.steps ?? []).find((s) => s.id === 'status' || s.code === 'status-failed');
  assert.ok(statusStep, 'HTTP diagnostics must surface status-failed');
  assert.equal(statusStep.ok, false);
  assert.equal(fake.active, true, 'diagnostics must not drop ownership');
  const again = await manager.start();
  assert.equal(fake.startCalls, 1, 'no second spawn after diagnostics status failure');
  assert.notEqual(again.overall.status, 'ready');
  await manager.dispose();
});

test('routes: unexpected handler error becomes 500 json, not an unhandled rejection', async () => {
  const { manager, getRoute } = await setup();
  const original = manager.refresh.bind(manager);
  manager.refresh = async () => {
    throw new Error('boom-refresh');
  };
  try {
    const res = await call(getRoute(), makeReq({ url: '/_dsh/chatgpt-bridge/status' }), makeRes());
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'internal-error');
    assert.ok(typeof body.message === 'string');
  } finally {
    manager.refresh = original;
    await manager.dispose();
  }
});
