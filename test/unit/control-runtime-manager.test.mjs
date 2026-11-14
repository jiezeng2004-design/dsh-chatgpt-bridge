import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { RuntimeManager, deriveOverallStatus, isLatchedLifecycleError, confirmsRuntimeGone } from '../../lib/control/runtime-manager.js';
import { FakeTunnelRuntime } from '../../lib/control/fake-tunnel-runtime.js';

const created = [];
after(async () => {
  for (const { server } of created) {
    try { await new Promise((resolve) => server.close(resolve)); } catch {}
  }
  for (const tmp of created.map((c) => c.tmp)) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function startFakeBridge() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const auth = req.headers.authorization;
      const ok = auth === 'Bearer test-token' || auth === 'Bearer sk-test-1234567890';
      res.statusCode = ok ? 400 : 401;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      created.push({ server, tmp: '' });
      resolve({ server, port });
    });
  });
}

function closedPort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** A server that answers every request with a fixed HTTP status. */
function startStatusServer(status) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.statusCode = status;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      created.push({ server, tmp: '' });
      resolve(server);
    });
  });
}

/** A control-plane stub whose origin root rejects, but tunnel metadata accepts. */
function startTunnelMetadataServer() {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      const accepted = req.url === '/v1/tunnel/tunnel_test' && req.headers.authorization === 'Bearer sk-test-1234567890';
      res.statusCode = accepted ? 200 : 401;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      created.push({ server, tmp: '' });
      resolve({ server, seen });
    });
  });
}

async function makeManager(overrides = {}) {
  const tmp = mkdtempSync(join(process.cwd(), '.ctrl-mgr-'));
  const bridge = overrides.port === undefined ? await startFakeBridge() : { port: overrides.port };
  const fake = overrides.fake ?? new FakeTunnelRuntime({ script: overrides.script });
  const manager = new RuntimeManager({
    dshHome: tmp,
    bridge: { url: `http://127.0.0.1:${bridge.port}/mcp`, token: 'test-token', authMode: 'token' },
    createRuntime: () => fake,
    pollIntervalMs: 50,
    readyTimeoutMs: 800,
    discover: overrides.discover ?? (() => ({})),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  manager.secretStore.writeRuntimeApiKey('sk-test-1234567890');
  await manager.saveConfig({
    tunnel: { tunnelId: 'tunnel_test', autoStart: false, proxy: { enabled: false } },
    openai: { controlPlaneBaseUrl: `http://127.0.0.1:${bridge.port}` },
  });
  created.push({ server: { close: (cb) => cb() }, tmp });
  return { tmp, fake, manager };
}

test('runtime-manager: start reaches ready', async () => {
  const { fake, manager } = await makeManager({ discover: () => ({}) });
  const snap = await manager.start();
  assert.equal(fake.startCalls, 1, 'without an external process the plugin must start its own runtime');
  assert.equal(snap.tunnel.status, 'running');
  assert.equal(snap.tunnel.processRunning, true);
  assert.equal(snap.tunnel.ready, true);
  assert.equal(snap.tunnel.owned, true);
  assert.equal(snap.bridge.status, 'running');
  assert.equal(snap.overall.status, 'ready');
  await manager.dispose();
});

test('runtime-manager: plugin-owned runtime probes the authenticated tunnel metadata endpoint, not the origin root', async () => {
  const controlPlane = await startTunnelMetadataServer();
  const { fake, manager } = await makeManager({ discover: () => ({}) });
  await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${controlPlane.server.address().port}/` } });
  assert.equal(manager.getConfig().tunnel.tunnelId, 'tunnel_test');
  const snap = await manager.start();
  assert.equal(fake.startCalls, 1);
  assert.equal(snap.tunnel.owned, true);
  assert.equal(snap.openai.status, 'connected', JSON.stringify(controlPlane.seen));
  assert.equal(snap.overall.status, 'ready');
  assert.ok(controlPlane.seen.length >= 1);
  assert.equal(controlPlane.seen.every((request) => request.url === '/v1/tunnel/tunnel_test'), true);
  assert.equal(controlPlane.seen.every((request) => request.authorization === 'Bearer sk-test-1234567890'), true);
  await manager.dispose();
});

test('runtime-manager: double start is idempotent', async () => {
  const { fake, manager } = await makeManager();
  await manager.start();
  const before = fake.activeHandle;
  const snap = await manager.start();
  assert.equal(fake.activeHandle, before, 'second start must not spawn a new runtime');
  assert.equal(snap.overall.status, 'ready');
  await manager.dispose();
});

test('runtime-manager: stop then double stop is safe', async () => {
  const { manager } = await makeManager();
  await manager.start();
  const snap = await manager.stop();
  assert.equal(snap.tunnel.status, 'stopped');
  assert.equal(snap.overall.status, 'stopped');
  const again = await manager.stop();
  assert.equal(again.tunnel.status, 'stopped');
  await manager.dispose();
});

test('runtime-manager: restart returns to ready', async () => {
  const { manager } = await makeManager();
  await manager.start();
  const snap = await manager.restart();
  assert.equal(snap.tunnel.ready, true);
  assert.equal(snap.overall.status, 'ready');
  await manager.dispose();
});

test('runtime-manager: start fails with bridge-unavailable when bridge down', async () => {
  const port = await closedPort();
  const { manager } = await makeManager({ port });
  const snap = await manager.start();
  assert.equal(snap.lastError?.code, 'bridge-unavailable');
  assert.equal(snap.lastError?.component, 'bridge');
  assert.notEqual(snap.overall.status, 'ready');
  await manager.dispose();
});

test('runtime-manager: start fails when runtime api key missing', async () => {
  const { manager } = await makeManager();
  manager.secretStore.clearRuntimeApiKey();
  const snap = await manager.start();
  assert.equal(snap.lastError?.code, 'runtime-api-key-missing');
  assert.equal(snap.lastError?.component, 'openai');
  await manager.dispose();
});

test('runtime-manager: start fails when tunnel id missing', async () => {
  const { manager } = await makeManager();
  await manager.saveConfig({ tunnel: { tunnelId: undefined, autoStart: false, proxy: { enabled: false } } });
  const snap = await manager.start();
  assert.equal(snap.lastError?.code, 'tunnel-id-missing');
  await manager.dispose();
});

test('runtime-manager: unexpected exit moves snapshot to error', async () => {
  let clock = 0;
  const fake = new FakeTunnelRuntime({ script: { exitAfterMs: 1000 }, now: () => clock });
  const { manager } = await makeManager({
    fake,
    now: () => clock,
  });
  const snap = await manager.start();
  assert.equal(snap.overall.status, 'ready');
  clock = 1001;
  await manager.refresh();
  const after = manager.getSnapshot();
  assert.equal(after.tunnel.status, 'error');
  assert.equal(after.overall.status, 'error');
  await manager.dispose();
});

test('runtime-manager: health failure surfaces health-failed', async () => {
  const { manager } = await makeManager({ script: { healthOk: false } });
  const snap = await manager.start();
  assert.equal(snap.lastError?.code, 'health-failed');
  await manager.dispose();
});

test('runtime-manager: ready failure surfaces tunnel-not-ready', async () => {
  const { manager } = await makeManager({ script: { readyOk: false } });
  const snap = await manager.start();
  assert.equal(snap.lastError?.code, 'tunnel-not-ready');
  await manager.dispose();
});

test('runtime-manager: start/stop/restart are serialized (no interleave crash)', async () => {
  const { manager } = await makeManager();
  const results = await Promise.all([
    manager.start(),
    manager.start(),
    manager.stop(),
    manager.start(),
    manager.restart(),
  ]);
  const last = results[results.length - 1];
  assert.equal(last.overall.status, 'ready');
  await manager.dispose();
});

test('runtime-manager: stop starts while stopping are serialized', async () => {
  const { manager } = await makeManager();
  const started = manager.start();
  const stopped = manager.stop();
  await Promise.all([started, stopped]);
  const snap = manager.getSnapshot();
  assert.ok(['stopped', 'ready'].includes(snap.overall.status), 'final state must be a valid terminal state');
  await manager.dispose();
});

test('runtime-manager: snapshot never carries the runtime api key', async () => {
  const { manager } = await makeManager();
  await manager.start();
  const raw = JSON.stringify(manager.getSnapshot());
  assert.ok(!raw.includes('sk-test-1234567890'), 'snapshot must not leak the key');
  await manager.dispose();
});

// ----------------------------------------------------------- overall matrix
test('runtime-manager: overall matrix — only connected yields ready', () => {
  const bridge = { status: 'running', url: 'http://127.0.0.1/mcp', reachable: true };
  const ready = { status: 'running', processRunning: true, healthy: true, ready: true };
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'connected' }).status, 'ready');
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'unknown' }).status, 'degraded');
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'unreachable' }).status, 'degraded');
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'unauthorized' }).status, 'degraded');
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'error' }).status, 'error');

  // lastError semantics are attached only when meaningful.
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'connected' }).lastError, undefined);
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'unknown' }).lastError, undefined);
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'unreachable' }).lastError?.code, 'control-plane-unreachable');
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'unauthorized' }).lastError?.code, 'runtime-api-unauthorized');
  assert.equal(deriveOverallStatus({ bridge, tunnel: ready, openai: 'error' }).lastError?.code, 'runtime-api-key-missing');
});

test('runtime-manager: overall matrix — readiness also requires a live ready tunnel', () => {
  const bridge = { status: 'running', url: 'http://127.0.0.1/mcp', reachable: true };
  const runningNotReady = { status: 'running', processRunning: true, healthy: true, ready: false };
  const stopped = { status: 'stopped', processRunning: false, healthy: false, ready: false };
  const errored = { status: 'error', processRunning: false, healthy: false, ready: false };
  assert.equal(deriveOverallStatus({ bridge, tunnel: runningNotReady, openai: 'connected' }).status, 'degraded');
  assert.equal(deriveOverallStatus({ bridge, tunnel: stopped, openai: 'connected' }).status, 'stopped');
  assert.equal(deriveOverallStatus({ bridge, tunnel: errored, openai: 'connected' }).status, 'error');
});

for (const statusCode of [401, 403]) {
  test(`runtime-manager: control plane ${statusCode} yields degraded in a plugin-owned runtime`, async () => {
    const unauthorized = await startStatusServer(statusCode);
    const { fake, manager } = await makeManager({ discover: () => ({}) });
    await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${unauthorized.address().port}` } });
    const snap = await manager.start();
    assert.equal(fake.startCalls, 1, 'the plugin-owned path must still start its own runtime');
    assert.equal(snap.tunnel.owned, true);
    assert.equal(snap.openai.status, 'unauthorized');
    assert.equal(snap.overall.status, 'degraded');
    assert.equal(snap.lastError?.code, 'runtime-api-unauthorized');
    const diag = await manager.diagnostics();
    const controlPlaneStep = diag.steps.find((step) => step.id === 'openai-control-plane');
    assert.equal(controlPlaneStep?.ok, false, 'plugin-owned diagnostics must keep validating the plugin key');
    assert.equal(controlPlaneStep?.code, 'runtime-api-unauthorized');
    await manager.dispose();
  });
}

test('runtime-manager: unreachable control plane yields degraded in a running runtime', async () => {
  const port = await closedPort();
  const { manager } = await makeManager();
  await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${port}` } });
  const snap = await manager.start();
  assert.equal(snap.openai.status, 'unreachable');
  assert.equal(snap.overall.status, 'degraded');
  assert.equal(snap.lastError?.code, 'control-plane-unreachable');
  await manager.dispose();
});

test('runtime-manager: observes an external ready tunnel-client without adopting it', async () => {
  const unauthorized = await startStatusServer(401);
  const health = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.statusCode = req.url === '/healthz' || req.url === '/readyz' ? 200 : 404;
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      created.push({ server, tmp: '' });
      resolve(server);
    });
  });
  const { fake, manager } = await makeManager({
    discover: () => ({
      runtimeApiKeyAvailable: true,
      healthBaseUrl: `http://127.0.0.1:${health.address().port}`,
      runningProcess: { pid: 16984, executablePath: 'D:\\tools\\tunnel-client\\tunnel-client.exe', proxyFlag: true },
      proxyInUse: true,
    }),
  });
  await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${unauthorized.address().port}` } });
  await manager.refresh();
  const snap = manager.getSnapshot();
  assert.equal(snap.tunnel.status, 'running');
  assert.equal(snap.tunnel.processRunning, true);
  assert.equal(snap.tunnel.ready, true);
  assert.equal(snap.tunnel.owned, false);
  assert.equal(snap.tunnel.pid, 16984);
  assert.equal(snap.openai.status, 'connected', 'a stale optional plugin key must not override a ready external runtime');
  assert.equal(snap.overall.status, 'ready');
  const diag = await manager.diagnostics();
  const controlPlaneStep = diag.steps.find((step) => step.id === 'openai-control-plane');
  assert.equal(controlPlaneStep?.ok, true, 'external-ready diagnostics must not validate an unrelated plugin key');
  assert.equal(diag.steps.some((step) => step.id === 'doctor'), false, 'plugin-owned doctor must not run against an external runtime');
  const started = await manager.start();
  assert.equal(fake.startCalls, 0, 'must not spawn a second tunnel-client over the working channel');
  assert.equal(started.tunnel.owned, false);
  await manager.dispose();
});

test('runtime-manager: an external process that is not ready never reports OpenAI connected', async () => {
  const health = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.statusCode = req.url === '/healthz' ? 200 : 503;
      res.end('not ready');
    });
    server.listen(0, '127.0.0.1', () => {
      created.push({ server, tmp: '' });
      resolve(server);
    });
  });
  const { manager } = await makeManager({
    discover: () => ({
      runtimeApiKeyAvailable: true,
      healthBaseUrl: `http://127.0.0.1:${health.address().port}`,
      runningProcess: { pid: 16985, executablePath: 'D:\\tools\\tunnel-client\\tunnel-client.exe', proxyFlag: true },
      proxyInUse: true,
    }),
  });
  await manager.refresh();
  const snap = manager.getSnapshot();
  assert.equal(snap.tunnel.owned, false);
  assert.equal(snap.tunnel.ready, false);
  assert.notEqual(snap.openai.status, 'connected');
  assert.notEqual(snap.overall.status, 'ready');
  await manager.dispose();
});

test('runtime-manager: missing key with stopped tunnel is openai unknown, not error', async () => {
  const { manager } = await makeManager();
  manager.secretStore.clearRuntimeApiKey();
  await manager.refresh();
  const snap = manager.getSnapshot();
  assert.equal(snap.tunnel.status, 'stopped');
  assert.equal(snap.openai.status, 'unknown', 'no OpenAI probe ran; missing key is not a connection failure');
  assert.notEqual(snap.openai.status, 'error');
  await manager.dispose();
});

test('runtime-manager: clearing the key moves OpenAI off connected and overall off ready', async () => {
  const { manager } = await makeManager();
  await manager.start();
  assert.equal(manager.getSnapshot().openai.status, 'connected');
  assert.equal(manager.getSnapshot().overall.status, 'ready');
  manager.secretStore.clearRuntimeApiKey();
  await manager.refresh();
  const snap = manager.getSnapshot();
  assert.notEqual(snap.openai.status, 'connected');
  assert.equal(snap.openai.status, 'error');
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.overall.status, 'error');
  assert.equal(snap.lastError?.code, 'runtime-api-key-missing');
  await manager.dispose();
});

// ------------------------------------------------------ restart fail-closed
test('runtime-manager: restart after a successful stop starts exactly one new runtime', async () => {
  const { fake, manager } = await makeManager();
  const first = await manager.start();
  assert.equal(first.overall.status, 'ready');
  assert.equal(fake.startCalls, 1);
  const snap = await manager.restart();
  assert.equal(snap.overall.status, 'ready');
  assert.equal(fake.startCalls, 2, 'one fresh runtime must be started for the restart');
  await manager.dispose();
});

test('runtime-manager: restart fails closed when stop reports a stale identity', async () => {
  const fake = new FakeTunnelRuntime({ script: { staleIdentity: true, healthOk: true, readyOk: true } });
  const { manager } = await makeManager({ fake });
  const started = await manager.start();
  assert.equal(started.overall.status, 'ready');
  const before = fake.startCalls;
  const snap = await manager.restart();
  assert.equal(fake.startCalls, before, 'start must NOT be called after a failed stop');
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.overall.status, 'error');
  assert.equal(snap.lastError?.code, 'stale-process-identity');
  await manager.dispose();
});

test('runtime-manager: restart fails closed when stop times out', async () => {
  const fake = new FakeTunnelRuntime({
    script: { stopError: { code: 'tunnel-stop-timeout', message: 'tunnel did not exit in time' }, healthOk: true, readyOk: true },
  });
  const { manager } = await makeManager({ fake });
  await manager.start();
  const before = fake.startCalls;
  const snap = await manager.restart();
  assert.equal(fake.startCalls, before, 'start must NOT be called after a stop failure');
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.overall.status, 'error');
  assert.equal(snap.lastError?.code, 'tunnel-stop-timeout');
  await manager.dispose();
});

// ---------------------------------------------------------- auto-start timer
test('runtime-manager: pending auto-start is cancelled by dispose', async () => {
  const fake = new FakeTunnelRuntime({ script: {} });
  const { manager } = await makeManager({ fake });
  await manager.saveConfig({ tunnel: { tunnelId: 'tunnel_test', autoStart: true, proxy: { enabled: false } } });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    manager.activate();
    assert.equal(fake.startCalls, 0);
    await manager.dispose();
    mock.timers.tick(2500);
    assert.equal(fake.startCalls, 0, 'auto-start must not fire after dispose');
  } finally {
    mock.timers.reset();
  }
});

test('runtime-manager: auto-start fires after the delay when not disposed', async () => {
  const fake = new FakeTunnelRuntime({ script: {} });
  const { manager } = await makeManager({ fake });
  await manager.saveConfig({ tunnel: { tunnelId: 'tunnel_test', autoStart: true, proxy: { enabled: false } } });
  manager.activate();
  const deadline = Date.now() + 5000;
  while (fake.startCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fake.startCalls, 1, 'auto-start should fire ~1.5s after activate');
  await manager.dispose();
});

// ---------------------------------------------------------- doctor + diagnostics
test('runtime-manager: diagnostics include the tunnel-client doctor steps', async () => {
  const { manager } = await makeManager();
  await manager.start();
  const result = await manager.diagnostics();
  const ids = result.steps.map((s) => s.id);
  assert.ok(ids.includes('tunnel-binary'), 'base layered steps present');
  assert.ok(ids.includes('bridge-endpoint'), 'base layered steps present');
  assert.ok(ids.includes('binary'), 'tunnel-client doctor child step included');
  assert.ok(result.steps.length > 9, 'doctor group appends to the layered steps');
  assert.equal(result.ok, true, 'fully healthy diagnostics pass');
  await manager.dispose();
});

test('runtime-manager: a failing doctor becomes a structured failed step (no crash)', async () => {
  const fake = new FakeTunnelRuntime({ script: { doctorOk: false } });
  const { manager } = await makeManager({ fake });
  await manager.start();
  const result = await manager.diagnostics();
  assert.equal(Array.isArray(result.steps), true);
  assert.equal(result.ok, false, 'a failing doctor makes diagnostics fail');
  assert.equal(result.steps.find((s) => s.id === 'key').ok, false);
  await manager.dispose();
});

// ---------------------------------------- failed-start cleanup ownership
// The ownership invariant: shutdown confirmed BEFORE the manager releases the
// handle. A failed start whose cleanup stop succeeds releases ownership; a
// failed cleanup stop retains it and blocks any further backend start.
test('failed-start cleanup: stop success releases ownership (Test 1)', async () => {
  const fake = new FakeTunnelRuntime({ script: { readyOk: false } });
  const { manager } = await makeManager({ fake });
  const snap = await manager.start();
  assert.equal(fake.startCalls, 1, 'one runtime was started');
  assert.equal(fake.stopCalls, 1, 'cleanup attempted one stop');
  assert.equal(fake.active, false, 'backend runtime is inactive');
  assert.equal(snap.tunnel.pid, undefined, 'manager no longer reports an owned pid');
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.lastError?.code, 'tunnel-not-ready', 'original startup error is surfaced');
  await manager.dispose();
});

test('failed-start cleanup: stale identity retains ownership (Test 2)', async () => {
  const fake = new FakeTunnelRuntime({ script: { readyOk: false, staleIdentity: true } });
  const { manager } = await makeManager({ fake });
  const snap = await manager.start();
  assert.equal(fake.startCalls, 1, 'one runtime was started');
  assert.equal(fake.stopCalls, 1, 'cleanup attempted one stop');
  assert.equal(fake.active, true, 'runtime remains active');
  assert.equal(snap.tunnel.processRunning, true, 'runtime is still represented as active/unresolved');
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.lastError?.code, 'stale-process-identity', 'cleanup failure is the surfaced error');
  await manager.dispose();
});

test('failed-start cleanup: a second start is blocked while ownership is unresolved (Test 3)', async () => {
  const fake = new FakeTunnelRuntime({ script: { readyOk: false, staleIdentity: true } });
  const { manager } = await makeManager({ fake });
  await manager.start();
  assert.equal(fake.startCalls, 1);
  const again = await manager.start();
  assert.equal(fake.startCalls, 1, 'second start must NOT call the backend start again');
  assert.equal(fake.active, true, 'runtime stays owned/unresolved');
  assert.notEqual(again.overall.status, 'ready');
  assert.equal(again.lastError?.code, 'stale-process-identity', 'ownership error remains meaningful');
  await manager.dispose();
});

test('failed-start cleanup: stop timeout retains ownership and blocks the next start (Test 4)', async () => {
  const fake = new FakeTunnelRuntime({
    script: { readyOk: false, stopError: { code: 'tunnel-stop-timeout', message: 'tunnel did not exit in time' } },
  });
  const { manager } = await makeManager({ fake });
  const snap = await manager.start();
  assert.equal(fake.startCalls, 1);
  assert.equal(fake.stopCalls, 1);
  assert.equal(fake.active, true, 'runtime remains active after a timeout stop');
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.lastError?.code, 'tunnel-stop-timeout');
  const again = await manager.start();
  assert.equal(fake.startCalls, 1, 'second start must NOT call the backend start again');
  assert.equal(again.lastError?.code, 'tunnel-stop-timeout', 'timeout error remains meaningful');
  await manager.dispose();
});

test('failed-start cleanup: a retry is allowed after confirmed cleanup (Test 5)', async () => {
  const fake = new FakeTunnelRuntime({ script: { readyOk: false } });
  const { manager } = await makeManager({ fake });
  const first = await manager.start();
  assert.equal(fake.startCalls, 1);
  assert.equal(fake.active, false, 'ownership was released after confirmed cleanup');
  assert.equal(first.lastError?.code, 'tunnel-not-ready');
  fake.setScript({ readyOk: true });
  const second = await manager.start();
  assert.equal(fake.startCalls, 2, 'a fresh start is allowed after confirmed cleanup');
  assert.equal(second.overall.status, 'ready');
  await manager.dispose();
});

// ---------------------------------------------------- lifecycle/ownership latch
// The release-blocking invariant this section pins down: an unresolved
// lifecycle/ownership error (stale-process-identity, start-time-mismatch,
// unknown-start-time, tunnel-stop-timeout) must keep overall away from ready
// no matter how healthy the runtime later becomes. Ordinary refresh()/polling
// proves the runtime is alive, NOT that the failed shutdown/identity problem
// was resolved — so only an explicit resolution (confirmed stop, confirmed
// cleanup, successful fresh start) may clear the latch.
test('lifecycle latch: restart ownership error survives refresh (Test 1)', async () => {
  const fake = new FakeTunnelRuntime({ script: { staleIdentity: true, healthOk: true, readyOk: true } });
  const { manager } = await makeManager({ fake });
  const started = await manager.start();
  assert.equal(started.overall.status, 'ready');
  const afterRestart = await manager.restart();
  assert.equal(afterRestart.overall.status, 'error');
  assert.equal(afterRestart.lastError?.code, 'stale-process-identity');
  assert.equal(fake.active, true, 'handle retained after the failed stop');
  // The backend keeps reporting a fully healthy, ready, connected runtime…
  await manager.refresh();
  const snap = manager.getSnapshot();
  assert.equal(snap.tunnel.processRunning, true, 'backend still reports the process running');
  assert.equal(snap.tunnel.healthy, true);
  assert.equal(snap.tunnel.ready, true);
  assert.equal(snap.openai.status, 'connected');
  // …but ordinary refresh must NOT wash the latched ownership error out.
  assert.notEqual(snap.overall.status, 'ready', 'refresh must not restore ready');
  assert.equal(snap.overall.status, 'error');
  assert.equal(snap.lastError?.code, 'stale-process-identity');
  assert.equal(fake.startCalls, 1, 'no backend start happened during refresh');
  await manager.dispose();
});

test('lifecycle latch: failed-start cleanup error survives later readiness (Test 2)', async () => {
  const fake = new FakeTunnelRuntime({ script: { readyOk: false, staleIdentity: true } });
  const { manager } = await makeManager({ fake });
  const snap = await manager.start();
  assert.equal(fake.startCalls, 1, 'one runtime was started');
  assert.equal(fake.stopCalls, 1, 'cleanup attempted one stop');
  assert.equal(fake.active, true, 'cleanup stop failed: ownership retained');
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.lastError?.code, 'stale-process-identity');
  // The runtime later becomes fully ready on its own.
  fake.setScript({ readyOk: true });
  await manager.refresh();
  const after = manager.getSnapshot();
  assert.equal(after.tunnel.processRunning, true);
  assert.equal(after.tunnel.ready, true, 'runtime now reports ready=true');
  assert.notEqual(after.overall.status, 'ready', 'later readiness must not clear the latch');
  assert.equal(after.overall.status, 'error');
  assert.equal(after.lastError?.code, 'stale-process-identity');
  assert.equal(fake.startCalls, 1, 'no further backend start');
  await manager.dispose();
});

test('lifecycle latch: confirmed stop resolves the latch (Test 3)', async () => {
  const fake = new FakeTunnelRuntime({ script: { readyOk: false, staleIdentity: true } });
  const { manager } = await makeManager({ fake });
  await manager.start();
  assert.equal(manager.getSnapshot().lastError?.code, 'stale-process-identity');
  assert.equal(fake.active, true, 'ownership unresolved before the retry');
  // The environment recovers: a later stop now succeeds.
  fake.setScript({ staleIdentity: false, readyOk: true });
  const snap = await manager.stop();
  assert.equal(fake.active, false, 'shutdown confirmed: ownership released');
  assert.equal(snap.overall.status, 'stopped');
  assert.equal(snap.lastError, undefined, 'lifecycle error cleared by confirmed stop');
  await manager.dispose();
});

test('lifecycle latch: fresh successful start after resolution becomes ready (Test 4)', async () => {
  const fake = new FakeTunnelRuntime({ script: { readyOk: false, staleIdentity: true } });
  const { manager } = await makeManager({ fake });
  await manager.start();
  assert.equal(fake.startCalls, 1);
  fake.setScript({ staleIdentity: false, readyOk: true });
  await manager.stop();
  const before = fake.startCalls;
  const snap = await manager.start();
  assert.equal(fake.startCalls, before + 1, 'fresh start spawns exactly one runtime');
  assert.equal(snap.overall.status, 'ready');
  assert.equal(snap.lastError, undefined, 'resolution + fresh start clears the latch');
  await manager.dispose();
});

test('lifecycle latch: classifier recognizes only the real lifecycle codes', () => {
  assert.equal(isLatchedLifecycleError(undefined), false);
  for (const code of ['stale-process-identity', 'start-time-mismatch', 'unknown-start-time', 'tunnel-stop-timeout']) {
    assert.equal(isLatchedLifecycleError({ code, message: 'x', component: 'tunnel' }), true, `${code} must latch`);
  }
  for (const code of ['tunnel-not-ready', 'health-failed', 'bridge-unavailable', 'runtime-api-key-missing', 'unexpected-exit', 'status-failed', 'runtime-error', 'doctor-failed']) {
    assert.equal(isLatchedLifecycleError({ code, message: 'x', component: 'runtime' }), false, `${code} must NOT latch`);
  }
});

// State-consistency invariant: a ready snapshot can never carry a lastError,
// and a latched ownership error can never be surfaced as ready. Walk the
// manager through its common states and check every produced snapshot.
test('lifecycle latch invariant: overall=ready never coexists with lastError', async () => {
  const fake = new FakeTunnelRuntime({ script: { staleIdentity: true, healthOk: true, readyOk: true } });
  const { manager } = await makeManager({ fake });
  const snapshots = [];
  const record = () => snapshots.push(manager.getSnapshot());
  record();                                  // initial: stopped
  await manager.start(); record();           // ready
  await manager.refresh(); record();         // ready (polling keeps it)
  await manager.restart(); record();         // error + stale-process-identity (latched)
  await manager.refresh(); record();         // still error (latch survives polling)
  fake.setScript({ staleIdentity: false });
  await manager.stop(); record();            // stopped — latch cleared by confirmed stop
  await manager.start(); record();           // ready — fresh start after resolution
  await manager.refresh(); record();         // ready — stable
  for (const snap of snapshots) {
    if (snap.overall.status === 'ready') {
      assert.equal(snap.lastError, undefined, 'ready snapshot must not carry lastError');
    }
  }
  await manager.dispose();
});

// ------------------------------------------------------- status probe provenance
// The invariant this section pins down: a thrown runtime.status() probe is
// "unknown", NEVER "confirmed exited". Ownership is released only on trusted
// confirmed-gone evidence from a successful probe (status=stopped or
// lastError=unexpected-exit) or a confirmed stop — never on uncertainty.
// A transient probe failure must therefore retain the handle, fail closed as
// status-failed, and recover automatically once the same handle can be
// probed successfully again.
test('status probe: failure retains ownership, fail-closed (Test 1)', async () => {
  const fake = new FakeTunnelRuntime({ script: { healthOk: true, readyOk: true } });
  const { manager } = await makeManager({ fake });
  const started = await manager.start();
  assert.equal(started.overall.status, 'ready');
  assert.equal(fake.startCalls, 1);
  fake.setStatusError(new Error('transient status failure'));
  const probesBefore = fake.statusCalls;
  await manager.refresh();
  assert.ok(fake.statusCalls > probesBefore, 'refresh actually invoked the throwing probe');
  const snap = manager.getSnapshot();
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.overall.status, 'error');
  assert.equal(snap.lastError?.code, 'status-failed');
  assert.equal(fake.active, true, 'runtime stays active: query failure is not an exit');
  assert.equal(fake.startCalls, 1, 'no backend start during the probe failure');
  await manager.dispose();
});

test('status probe: second start after a probe failure does not spawn (Test 2)', async () => {
  const fake = new FakeTunnelRuntime({ script: { healthOk: true, readyOk: true } });
  const { manager } = await makeManager({ fake });
  await manager.start();
  assert.equal(fake.startCalls, 1);
  fake.setStatusError(new Error('transient status failure'));
  await manager.refresh();
  assert.equal(manager.getSnapshot().lastError?.code, 'status-failed');
  fake.setStatusError(undefined);
  const snap = await manager.start();
  assert.equal(fake.startCalls, 1, 'second start must NOT call the backend start again');
  assert.equal(fake.active, true, 'manager still manages the same runtime');
  assert.equal(snap.overall.status, 'ready');
  assert.equal(snap.lastError, undefined);
  await manager.dispose();
});

test('status probe: recovery via refresh restores ready on the same handle (Test 3)', async () => {
  const fake = new FakeTunnelRuntime({ script: { healthOk: true, readyOk: true } });
  const { manager } = await makeManager({ fake });
  await manager.start();
  fake.setStatusError(new Error('transient status failure'));
  await manager.refresh();
  const failed = manager.getSnapshot();
  assert.equal(failed.overall.status, 'error');
  assert.equal(failed.lastError?.code, 'status-failed');
  fake.setStatusError(undefined);
  await manager.refresh();
  const recovered = manager.getSnapshot();
  assert.equal(recovered.overall.status, 'ready');
  assert.equal(recovered.lastError, undefined);
  assert.equal(recovered.tunnel.processRunning, true);
  assert.equal(fake.startCalls, 1, 'no backend start during recovery');
  await manager.dispose();
});

test('status probe: confirmed stopped releases ownership, fresh start allowed (Test 4)', async () => {
  const fake = new FakeTunnelRuntime({ script: { healthOk: true, readyOk: true } });
  const { manager } = await makeManager({ fake });
  await manager.start();
  assert.equal(fake.startCalls, 1);
  fake.setScript({ stopped: true });
  await manager.refresh();
  const snap = manager.getSnapshot();
  assert.equal(snap.overall.status, 'stopped');
  assert.equal(fake.active, false, 'backend confirms the runtime is gone');
  fake.setScript({ stopped: false });
  const again = await manager.start();
  assert.equal(fake.startCalls, 2, 'fresh start allowed after confirmed exit');
  assert.equal(again.overall.status, 'ready');
  await manager.dispose();
});

test('status probe: confirmed unexpected exit releases ownership (Test 5)', async () => {
  let clock = 0;
  const fake = new FakeTunnelRuntime({ script: { exitAfterMs: 1000, healthOk: true, readyOk: true }, now: () => clock });
  const { manager } = await makeManager({ fake, now: () => clock });
  await manager.start();
  assert.equal(fake.startCalls, 1);
  clock = 1001;
  await manager.refresh();
  const snap = manager.getSnapshot();
  assert.notEqual(snap.overall.status, 'ready');
  assert.equal(snap.overall.status, 'error');
  assert.equal(fake.active, false, 'backend confirms the process exited');
  const again = await manager.start();
  assert.equal(fake.startCalls, 2, 'fresh start allowed after confirmed exit');
  assert.equal(again.overall.status, 'ready');
  await manager.dispose();
});

test('status probe provenance: only successful confirmed-gone evidence releases', () => {
  // The synthetic "unknown" status produced for a THROWN probe is NOT evidence.
  assert.equal(confirmsRuntimeGone({ status: 'error', processRunning: false, healthy: false, ready: false, lastError: { code: 'status-failed', message: 'runtime status unavailable' } }), false);
  // processRunning=true is never gone, whatever else the status says.
  assert.equal(confirmsRuntimeGone({ status: 'running', processRunning: true, healthy: true, ready: true }), false);
  assert.equal(confirmsRuntimeGone({ status: 'starting', processRunning: true, healthy: false, ready: false }), false);
  assert.equal(confirmsRuntimeGone({ status: 'stopping', processRunning: true, healthy: false, ready: false }), false);
  // A successful probe with an error status but NO confirmed-exit marker is
  // unknown, not gone (e.g. a future backend RPC/query error).
  assert.equal(confirmsRuntimeGone({ status: 'error', processRunning: false, healthy: false, ready: false }), false);
  assert.equal(confirmsRuntimeGone({ status: 'error', processRunning: false, healthy: false, ready: false, lastError: { code: 'health-failed', message: 'x' } }), false);
  assert.equal(confirmsRuntimeGone({ status: 'error', processRunning: false, healthy: false, ready: false, lastError: { code: 'ready-failed', message: 'x' } }), false);
  // Trusted confirmed-gone evidence (real backend codes only).
  assert.equal(confirmsRuntimeGone({ status: 'stopped', processRunning: false, healthy: false, ready: false }), true);
  assert.equal(confirmsRuntimeGone({ status: 'error', processRunning: false, healthy: false, ready: false, lastError: { code: 'unexpected-exit', message: 'x' } }), true);
});

test('diagnostics: status() throw reports status-failed and retains ownership', async () => {
  const fake = new FakeTunnelRuntime({ script: { healthOk: true, readyOk: true } });
  const { manager } = await makeManager({ fake });
  const started = await manager.start();
  assert.equal(started.overall.status, 'ready');
  assert.equal(started.tunnel.owned, true);
  assert.equal(fake.startCalls, 1);
  fake.setStatusError(new Error('diagnostics status exploded'));
  const result = await manager.diagnostics();
  assert.equal(result.ok, false);
  const statusStep = result.steps.find((s) => s.id === 'status');
  assert.ok(statusStep, 'diagnostics must include a status step');
  assert.equal(statusStep.ok, false);
  assert.equal(statusStep.code, 'status-failed');
  assert.equal(fake.active, true, 'handle retained: query failure is not an exit');
  assert.equal(manager.getSnapshot().tunnel.owned, true);
  const again = await manager.start();
  assert.equal(fake.startCalls, 1, 'second start must NOT spawn while ownership is retained');
  assert.equal(fake.active, true);
  assert.notEqual(again.overall.status, 'ready');
  assert.equal(again.lastError?.code, 'status-failed');
  await manager.dispose();
});

test('runtime-manager: start throw after spawn retains leftover handle', async () => {
  const fake = new FakeTunnelRuntime({
    script: {
      startResult: 'failure',
      retainHandleOnStartFailure: true,
      healthOk: false,
      readyOk: false,
      startError: { code: 'tunnel-health-url-timeout', message: 'no health url' },
    },
  });
  const { manager } = await makeManager({ fake });
  const snap = await manager.start();
  assert.equal(fake.startCalls, 1);
  assert.equal(fake.active, true, 'backend kept the spawned handle');
  assert.equal(snap.lastError?.code, 'tunnel-health-url-timeout');
  assert.notEqual(snap.overall.status, 'ready', 'a failed start must not report overall ready');
  assert.equal(snap.tunnel.owned, true, 'manager must adopt the leftover owned handle');
  const again = await manager.start();
  assert.equal(fake.startCalls, 1, 'second start must not spawn over an unconfirmed leftover');
  assert.equal(fake.active, true);
  assert.notEqual(again.overall.status, 'ready');
  await manager.dispose();
});

test('runtime-manager: stop failure does not report stopped', async () => {
  const fake = new FakeTunnelRuntime({
    script: { staleIdentity: true, healthOk: true, readyOk: true },
  });
  const { manager } = await makeManager({ fake });
  await manager.start();
  const snap = await manager.stop();
  assert.notEqual(snap.tunnel.status, 'stopped');
  assert.equal(snap.overall.status, 'error');
  assert.equal(snap.lastError?.code, 'stale-process-identity');
  assert.equal(fake.active, true);
  await manager.dispose();
});

// -------------------------------------------- control-plane probe cache (P0)
test('runtime-manager: saveConfig invalidates the cached control-plane probe so the next refresh re-probes', async () => {
  const cp = await startStatusServer(200);
  const { manager } = await makeManager({ now: () => 1000 });
  await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${cp.address().port}` } });
  await manager.start();
  await manager.refresh();
  assert.equal(manager.getSnapshot().openai.status, 'connected');

  // Fixed (never-advancing) clock: the 30s TTL can never expire, so a change
  // below is observable ONLY because saveConfig clears the probe cache.
  await new Promise((resolve) => cp.close(() => resolve()));

  // Cache hit: still "connected" with no invalidation.
  await manager.refresh();
  assert.equal(manager.getSnapshot().openai.status, 'connected', 'cached probe result must be served while the TTL is fresh');

  // proxy.enabled / host / port change -> saveConfig -> cache invalidated.
  await manager.saveConfig({ tunnel: { proxy: { enabled: true, host: '127.0.0.1', port: 1 } } });
  await manager.refresh();
  assert.equal(manager.getSnapshot().openai.status, 'unreachable', 'proxy save must invalidate the cached probe and re-probe the now-closed server');
  await manager.dispose();
});

test('runtime-manager: controlPlaneBaseUrl change invalidates the cached probe and probes the new URL', async () => {
  const cpA = await startStatusServer(200);
  const cpB = await closedPort(); // dead second target
  const { manager } = await makeManager({ now: () => 1000 });
  await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${cpA.address().port}` } });
  await manager.start();
  await manager.refresh();
  assert.equal(manager.getSnapshot().openai.status, 'connected');
  await new Promise((resolve) => cpA.close(() => resolve()));

  await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${cpB}` } });
  await manager.refresh();
  assert.equal(manager.getSnapshot().openai.status, 'unreachable', 'base-url save must invalidate and re-probe the new (dead) URL');
  await manager.dispose();
});

test('runtime-manager: Runtime API Key write invalidates the cached control-plane probe', async () => {
  const cp = await startStatusServer(200);
  const { manager } = await makeManager({ now: () => 1000 });
  await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${cp.address().port}` } });
  await manager.start();
  await manager.refresh();
  assert.equal(manager.getSnapshot().openai.status, 'connected');
  await new Promise((resolve) => cp.close(() => resolve()));

  const ref = manager.secretStore.writeRuntimeApiKey('sk-new-9876543210');
  await manager.saveConfig({ openai: { runtimeApiKeyRef: ref } });
  await manager.refresh();
  assert.equal(manager.getSnapshot().openai.status, 'unreachable', 'key write must invalidate the cached probe');
  await manager.dispose();
});

test('runtime-manager: status and diagnostics never diverge on the control-plane verdict', async () => {
  // Healthy target: both surfaces agree on connected / PASS.
  const cp = await startStatusServer(200);
  const { manager } = await makeManager();
  await manager.saveConfig({ openai: { controlPlaneBaseUrl: `http://127.0.0.1:${cp.address().port}` } });
  await manager.start();
  await manager.refresh();
  let diag = await manager.diagnostics();
  let step = diag.steps.find((s) => s.id === 'openai-control-plane');
  const statusP = manager.getSnapshot().openai.status;
  assert.equal(statusP, 'connected');
  if (step !== undefined) assert.equal(step.ok, true, 'PASS status must never coexist with a FAIL diagnostics step');

  // Dead target: both surfaces agree on unreachable / FAIL.
  await new Promise((resolve) => cp.close(() => resolve()));
  await manager.saveConfig({ tunnel: { proxy: { enabled: true, host: '127.0.0.1', port: 1 } } }); // invalidate cache -> re-probe
  await manager.refresh();
  diag = await manager.diagnostics();
  step = diag.steps.find((s) => s.id === 'openai-control-plane');
  const statusF = manager.getSnapshot().openai.status;
  assert.equal(statusF, 'unreachable');
  if (step !== undefined) assert.equal(step.ok, false, 'FAIL status must never coexist with a PASS diagnostics step');
  // The stable step code is preserved; only the detail gains redacted provenance.
  assert.equal(step?.code, 'control-plane-unreachable');
  assert.ok(step?.detail !== undefined && step.detail.includes('control plane unreachable'), 'stable code and detail are preserved');
  await manager.dispose();
});
