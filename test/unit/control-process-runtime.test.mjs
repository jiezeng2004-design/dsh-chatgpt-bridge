import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ProcessTunnelRuntime } from '../../lib/control/process-tunnel-runtime.js';

const tmp = mkdtempSync(join(process.cwd(), '.ctrl-proc-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A real, existing executable path (spawn is mocked, so nothing actually runs).
const FAKE_BINARY = process.execPath;

function mockChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };
  return child;
}

function makeLaunch(overrides = {}) {
  return {
    executablePath: FAKE_BINARY,
    profilePath: join(tmp, 'p.yaml'),
    profileDir: tmp,
    profileName: 'p',
    tunnelId: 'tunnel_test',
    runtimeApiKeyRef: 'file:' + join(tmp, 'k'),
    mcpAuthorizationRef: 'file:' + join(tmp, 'a'),
    bridgeUrl: 'http://127.0.0.1:3456/mcp',
    healthUrlFile: join(tmp, 'health.url'),
    pidFile: join(tmp, 'pid'),
    logFile: join(tmp, 'log.ndjson'),
    ...overrides,
  };
}

test('process-runtime: start spawns with shell:false and structured argv', async () => {
  const child = mockChild(4242);
  let spawnCall;
  const runtime = new ProcessTunnelRuntime({
    spawnFn: (file, args, opts) => {
      spawnCall = { file, args, opts };
      return child;
    },
    httpGetStatusFn: async () => 200,
    isAliveFn: () => true,
  });
  writeFileSync(join(tmp, 'health.url'), 'http://127.0.0.1:7777', 'utf8');
  const launch = makeLaunch({ env: { CONTROL_PLANE_API_KEY: 'sk-inherited-must-not-win' } });
  const handle = await runtime.start(launch);
  assert.equal(handle.identity.pid, 4242);
  assert.equal(handle.identity.executablePath, FAKE_BINARY);
  assert.ok(spawnCall.args[0] === 'run');
  assert.ok(spawnCall.args.includes('--profile-file'));
  const apiKeyFlag = spawnCall.args.indexOf('--control-plane.api-key');
  assert.notEqual(apiKeyFlag, -1, 'plugin-owned runs must pin the SecretStore file by flag');
  assert.equal(spawnCall.args[apiKeyFlag + 1], launch.runtimeApiKeyRef);
  assert.ok(spawnCall.args.includes('--health.listen-addr'));
  assert.ok(spawnCall.args.includes('127.0.0.1:0'));
  assert.equal(spawnCall.opts.shell, false);
  const status = await runtime.status(handle);
  assert.equal(status.processRunning, true);
  assert.equal(status.healthy, true);
  assert.equal(status.ready, true);
  await runtime.dispose();
});

test('process-runtime: unexpected exit surfaces error status', async () => {
  const child = mockChild(4243);
  const runtime = new ProcessTunnelRuntime({
    spawnFn: () => child,
    httpGetStatusFn: async () => 200,
    isAliveFn: () => true,
  });
  writeFileSync(join(tmp, 'health.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(makeLaunch());
  child.exitCode = 1; // real Node sets exitCode before emitting exit
  child.emit('exit', 1, null);
  const status = await runtime.status(handle);
  assert.equal(status.status, 'error');
  assert.equal(status.lastError?.code, 'unexpected-exit');
  await runtime.dispose();
});

test('process-runtime: proxy is passed via structured flag and env', async () => {
  const child = mockChild(4244);
  let spawnCall;
  const runtime = new ProcessTunnelRuntime({
    spawnFn: (file, args, opts) => {
      spawnCall = { file, args, opts };
      return child;
    },
    httpGetStatusFn: async () => 200,
    isAliveFn: () => true,
  });
  writeFileSync(join(tmp, 'health.url'), 'http://127.0.0.1:7777', 'utf8');
  const launch = makeLaunch({ proxy: { enabled: true, scheme: 'http', host: '127.0.0.1', port: 7892 } });
  await runtime.start(launch);
  assert.ok(spawnCall.args.includes('--http-proxy'));
  assert.ok(spawnCall.args.includes('http://127.0.0.1:7892'));
  assert.equal(spawnCall.opts.env.HTTP_PROXY, 'http://127.0.0.1:7892');
  assert.equal(spawnCall.opts.env.NO_PROXY, '127.0.0.1,localhost,::1');
  await runtime.dispose();
});

test('process-runtime: detect resolves configured executable and version', async () => {
  const runtime = new ProcessTunnelRuntime({
    spawnSyncFn: (file, args) => ({ stdout: 'tunnel-client 0.0.11+abc\n', stderr: '', status: 0 }),
    isAliveFn: () => true,
  });
  runtime.configure({ executable: FAKE_BINARY });
  const result = await runtime.detect();
  assert.equal(result.installed, true);
  assert.equal(result.executablePath, FAKE_BINARY);
  assert.equal(result.version, '0.0.11');
  assert.equal(result.source, 'configured');
});

test('process-runtime: detect uses well-known discovery when unconfigured', async () => {
  const wellKnown = 'D:\\Application\\tunnel-client\\tunnel-client.exe';
  const runtime = new ProcessTunnelRuntime({
    spawnSyncFn: () => ({ stdout: 'tunnel-client 0.0.11\n', stderr: '', status: 0 }),
    isAliveFn: () => true,
    discoverExecutable: (configured) => {
      if (configured) return { path: configured, source: 'configured' };
      return { path: wellKnown, source: 'well-known' };
    },
  });
  const result = await runtime.detect();
  assert.equal(result.installed, true);
  assert.equal(result.executablePath, wellKnown);
  assert.equal(result.source, 'well-known');
});

test('process-runtime: detect reports not-installed when discovery finds nothing', async () => {
  const runtime = new ProcessTunnelRuntime({
    discoverExecutable: () => undefined,
  });
  const result = await runtime.detect();
  assert.equal(result.installed, false);
  assert.equal(result.error, 'tunnel-client-not-found');
});

test('process-runtime: doctor maps structured steps from --json', async () => {
  const fakeJson = JSON.stringify({
    result: 'fail',
    checks: [
      { id: 'config_source', status: 'PASS', summary: 'profile' },
      { id: 'mcp_server_reachable', status: 'FAIL', summary: 'refused' },
    ],
  });
  let doctorArgs;
  const runtime = new ProcessTunnelRuntime({
    spawnSyncFn: (_file, args) => {
      doctorArgs = args;
      return { stdout: fakeJson, stderr: '', status: 0 };
    },
    isAliveFn: () => true,
  });
  const result = await runtime.doctor(makeLaunch());
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].id, 'mcp_server_reachable');
  assert.equal(result.steps[1].ok, false);
  const apiKeyFlag = doctorArgs.indexOf('--control-plane.api-key');
  assert.notEqual(apiKeyFlag, -1, 'doctor must validate the same plugin SecretStore file');
  assert.equal(doctorArgs[apiKeyFlag + 1], makeLaunch().runtimeApiKeyRef);
});

// ------------------------------------------------ hard-kill ownership (P0)
// Destructive SIGKILL / taskkill /F is allowed only after a FRESH identity
// verification (pid + executable + start time). There is no skip-verify path.

function uniqueLaunch(overrides = {}) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return makeLaunch({
    healthUrlFile: join(tmp, `health-${id}.url`),
    pidFile: join(tmp, `pid-${id}`),
    logFile: join(tmp, `log-${id}.ndjson`),
    ...overrides,
  });
}

function ownershipRuntime(opts) {
  const verifyQueue = [...(opts.verifyQueue ?? [{ ok: true, code: 'verified' }])];
  let verifyIndex = 0;
  const spawnSyncCalls = [];
  const killCalls = [];
  const child = opts.child ?? mockChild(opts.pid ?? 51001);
  const runtime = new ProcessTunnelRuntime({
    spawnFn: () => child,
    spawnSyncFn: (file, args) => {
      spawnSyncCalls.push({ file, args });
      return { status: 0, stdout: '', stderr: '' };
    },
    httpGetStatusFn: async () => 200,
    isAliveFn: opts.isAliveFn ?? (() => true),
    verifyIdentityFn: (identity) => {
      const next = verifyQueue[Math.min(verifyIndex, verifyQueue.length - 1)];
      verifyIndex += 1;
      if (typeof next === 'function') return next(identity);
      return next;
    },
    processKillFn: (pid, signal) => {
      killCalls.push({ pid, signal });
      if (opts.onKill !== undefined) opts.onKill(pid, signal);
      return true;
    },
    platform: opts.platform ?? 'linux',
    gracefulTimeoutMs: 0,
    hardKillTimeoutMs: 0,
    healthUrlTimeoutMs: opts.healthUrlTimeoutMs ?? 15_000,
    discoverExecutable: () => ({ path: FAKE_BINARY, source: 'configured' }),
  });
  return { runtime, child, spawnSyncCalls, killCalls, getVerifyCount: () => verifyIndex };
}

function taskkillCalled(spawnSyncCalls, pid) {
  return spawnSyncCalls.some(
    (call) =>
      call.file === 'taskkill' &&
      Array.isArray(call.args) &&
      call.args.includes('/PID') &&
      call.args.includes(String(pid)) &&
      call.args.includes('/T') &&
      call.args.includes('/F'),
  );
}

test('process-runtime: startup health timeout cleanup verifies identity before kill', async () => {
  let alive = true;
  const { runtime, spawnSyncCalls, killCalls, getVerifyCount } = ownershipRuntime({
    pid: 52001,
    platform: 'linux',
    healthUrlTimeoutMs: 0,
    isAliveFn: () => alive,
    onKill: (_pid, signal) => {
      if (signal === 'SIGKILL') alive = false;
    },
    verifyQueue: [
      { ok: true, code: 'verified' },
      { ok: true, code: 'verified' },
    ],
  });
  await assert.rejects(
    () => runtime.start(uniqueLaunch()),
    (err) => {
      assert.equal(err.code, 'tunnel-health-url-timeout');
      return true;
    },
  );
  assert.ok(getVerifyCount() >= 2, 'health-timeout cleanup must verify identity before SIGTERM and again before SIGKILL');
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL'), true, 'verified identity may escalate to SIGKILL');
  assert.equal(taskkillCalled(spawnSyncCalls, 52001), false);
  await runtime.dispose();
});

test('process-runtime: health timeout reports the child exit code and last stderr line', async () => {
  const child = mockChild(52005);
  const runtime = new ProcessTunnelRuntime({
    spawnFn: () => {
      // A tunnel-client that rejects the plugin's argv exits immediately. Emit on
      // the next tick so the runtime has attached its listeners first.
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from('unknown flag: --admin-ui.log-buffer-events\n'));
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    },
    spawnSyncFn: () => ({ status: 0, stdout: '', stderr: '' }),
    httpGetStatusFn: async () => 200,
    isAliveFn: () => false,
    verifyIdentityFn: () => ({ ok: true, code: 'verified' }),
    processKillFn: () => true,
    platform: 'linux',
    gracefulTimeoutMs: 0,
    hardKillTimeoutMs: 0,
    healthUrlTimeoutMs: 25,
    discoverExecutable: () => ({ path: FAKE_BINARY, source: 'configured' }),
  });
  await assert.rejects(
    () => runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-missing.url') })),
    (err) => {
      assert.equal(err.code, 'tunnel-health-url-timeout');
      assert.match(err.message, /exit=1/);
      assert.match(err.message, /unknown flag: --admin-ui\.log-buffer-events/);
      return true;
    },
  );
  await runtime.dispose();
});

test('process-runtime: graceful stop then PID gone does not hard-kill', async () => {
  const child = mockChild(52002);
  let alive = true;
  const { runtime, spawnSyncCalls, killCalls, getVerifyCount } = ownershipRuntime({
    pid: 52002,
    child,
    platform: 'linux',
    isAliveFn: () => alive,
    verifyQueue: [{ ok: true, code: 'verified' }],
  });
  writeFileSync(join(tmp, 'health-stop-gone.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-stop-gone.url') }));
  const originalKill = child.kill;
  child.kill = () => {
    alive = false;
    return originalKill();
  };
  await runtime.stop(handle);
  assert.equal(getVerifyCount(), 1, 'only the pre-SIGTERM verification runs when the pid is gone');
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL'), false, 'must not SIGKILL a pid that already exited');
  assert.equal(taskkillCalled(spawnSyncCalls, 52002), false);
  await runtime.dispose();
});

test('process-runtime: identity change after graceful stop refuses hard kill', async () => {
  const { runtime, spawnSyncCalls, killCalls, getVerifyCount } = ownershipRuntime({
    pid: 52003,
    platform: 'linux',
    verifyQueue: [
      { ok: true, code: 'verified' },
      { ok: false, code: 'executable-mismatch' },
    ],
  });
  writeFileSync(join(tmp, 'health-mismatch.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-mismatch.url') }));
  await assert.rejects(
    () => runtime.stop(handle),
    (err) => {
      assert.equal(err.code, 'stale-process-identity');
      assert.match(String(err.message), /hard-kill/);
      return true;
    },
  );
  assert.ok(getVerifyCount() >= 2, 'hard-kill path must re-verify identity');
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL'), false, 'identity mismatch must not SIGKILL');
  assert.equal(taskkillCalled(spawnSyncCalls, 52003), false);
  await runtime.dispose();
});

test('process-runtime: simulated PID reuse (start-time-mismatch) refuses hard kill', async () => {
  const { runtime, spawnSyncCalls, killCalls } = ownershipRuntime({
    pid: 52004,
    platform: 'linux',
    verifyQueue: [
      { ok: true, code: 'verified' },
      { ok: false, code: 'start-time-mismatch' },
    ],
  });
  writeFileSync(join(tmp, 'health-reuse.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-reuse.url') }));
  await assert.rejects(() => runtime.stop(handle), (err) => err.code === 'stale-process-identity');
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL'), false);
  assert.equal(taskkillCalled(spawnSyncCalls, 52004), false);
  await runtime.dispose();
});

test('process-runtime: identity probe failure refuses hard kill', async () => {
  const { runtime, spawnSyncCalls, killCalls } = ownershipRuntime({
    pid: 52005,
    platform: 'linux',
    verifyQueue: [
      { ok: true, code: 'verified' },
      { ok: false, code: 'unknown-start-time' },
    ],
  });
  writeFileSync(join(tmp, 'health-probe.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-probe.url') }));
  await assert.rejects(() => runtime.stop(handle), (err) => err.code === 'stale-process-identity');
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL'), false);
  assert.equal(taskkillCalled(spawnSyncCalls, 52005), false);
  await runtime.dispose();
});

test('process-runtime: identity probe throw refuses hard kill', async () => {
  const { runtime, killCalls, spawnSyncCalls } = ownershipRuntime({
    pid: 52006,
    platform: 'linux',
    verifyQueue: [
      { ok: true, code: 'verified' },
      () => {
        throw new Error('probe exploded');
      },
    ],
  });
  writeFileSync(join(tmp, 'health-probe-throw.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-probe-throw.url') }));
  await assert.rejects(() => runtime.stop(handle), (err) => err.code === 'stale-process-identity');
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL'), false);
  assert.equal(taskkillCalled(spawnSyncCalls, 52006), false);
  await runtime.dispose();
});

test('process-runtime: Windows hard-kill fallback uses taskkill /T /F after re-verify', async () => {
  const { runtime, spawnSyncCalls, killCalls, getVerifyCount } = ownershipRuntime({
    pid: 52007,
    platform: 'win32',
    verifyQueue: [
      { ok: true, code: 'verified' },
      { ok: true, code: 'verified' },
    ],
    isAliveFn: (() => {
      let live = true;
      return () => live;
    })(),
  });
  writeFileSync(join(tmp, 'health-win.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-win.url') }));
  // Keep the pid "alive" through the graceful wait so escalation is required.
  await runtime.stop(handle).catch(() => {});
  assert.ok(getVerifyCount() >= 2, 'Windows hard-kill must re-verify before taskkill');
  assert.equal(taskkillCalled(spawnSyncCalls, 52007), true, 'win32 hard-kill is taskkill /PID /T /F');
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL'), false, 'win32 must not use POSIX SIGKILL');
  await runtime.dispose();
});

test('process-runtime: Windows identity mismatch never calls taskkill /F', async () => {
  const { runtime, spawnSyncCalls, killCalls } = ownershipRuntime({
    pid: 52008,
    platform: 'win32',
    verifyQueue: [
      { ok: true, code: 'verified' },
      { ok: false, code: 'start-time-mismatch' },
    ],
  });
  writeFileSync(join(tmp, 'health-win-mismatch.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-win-mismatch.url') }));
  await assert.rejects(() => runtime.stop(handle), (err) => err.code === 'stale-process-identity');
  assert.equal(taskkillCalled(spawnSyncCalls, 52008), false, 'must not taskkill /F a reused pid');
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL'), false);
  await runtime.dispose();
});

test('process-runtime: POSIX SIGKILL fallback after re-verify', async () => {
  let alive = true;
  const { runtime, killCalls, spawnSyncCalls, getVerifyCount } = ownershipRuntime({
    pid: 52009,
    platform: 'linux',
    isAliveFn: () => alive,
    onKill: (_pid, signal) => {
      if (signal === 'SIGKILL') alive = false;
    },
    verifyQueue: [
      { ok: true, code: 'verified' },
      { ok: true, code: 'verified' },
    ],
  });
  writeFileSync(join(tmp, 'health-posix.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-posix.url') }));
  await runtime.stop(handle);
  assert.ok(getVerifyCount() >= 2);
  assert.equal(killCalls.some((k) => k.signal === 'SIGKILL' && k.pid === 52009), true);
  assert.equal(taskkillCalled(spawnSyncCalls, 52009), false);
  await runtime.dispose();
});

test('process-runtime: unexpected exit surfaces error status (lifecycle)', async () => {
  const child = mockChild(52010);
  const runtime = new ProcessTunnelRuntime({
    spawnFn: () => child,
    httpGetStatusFn: async () => 200,
    isAliveFn: () => true,
    verifyIdentityFn: () => ({ ok: true, code: 'verified' }),
    gracefulTimeoutMs: 0,
    hardKillTimeoutMs: 0,
    discoverExecutable: () => ({ path: FAKE_BINARY, source: 'configured' }),
  });
  writeFileSync(join(tmp, 'health-exit.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-exit.url') }));
  child.exitCode = 1;
  child.emit('exit', 1, null);
  const status = await runtime.status(handle);
  assert.equal(status.status, 'error');
  assert.equal(status.lastError?.code, 'unexpected-exit');
  await runtime.dispose();
});

test('process-runtime: status probe failure does not clear the owned handle', async () => {
  const runtime = new ProcessTunnelRuntime({
    spawnFn: () => mockChild(52011),
    httpGetStatusFn: async () => {
      throw new Error('health probe exploded');
    },
    isAliveFn: () => true,
    verifyIdentityFn: () => ({ ok: true, code: 'verified' }),
    gracefulTimeoutMs: 0,
    hardKillTimeoutMs: 0,
    discoverExecutable: () => ({ path: FAKE_BINARY, source: 'configured' }),
  });
  writeFileSync(join(tmp, 'health-status.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-status.url') }));
  const status = await runtime.status(handle);
  assert.equal(status.processRunning, true);
  assert.equal(runtime.ownedHandle(), handle);
  await runtime.dispose();
});

test('process-runtime: stop timeout after verified hard-kill keeps the handle', async () => {
  const { runtime } = ownershipRuntime({
    pid: 52012,
    platform: 'linux',
    isAliveFn: () => true,
    verifyQueue: [
      { ok: true, code: 'verified' },
      { ok: true, code: 'verified' },
    ],
  });
  writeFileSync(join(tmp, 'health-timeout.url'), 'http://127.0.0.1:7777', 'utf8');
  const handle = await runtime.start(uniqueLaunch({ healthUrlFile: join(tmp, 'health-timeout.url') }));
  await assert.rejects(() => runtime.stop(handle), (err) => err.code === 'tunnel-stop-timeout');
  assert.equal(runtime.ownedHandle(), handle, 'unconfirmed stop must retain ownership');
  await runtime.dispose();
});
