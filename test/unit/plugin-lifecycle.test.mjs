import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name, Config } from '../../lib/index.js';
import { createMcpServer } from '../../lib/mcp.js';
import { startHttpServer } from '../../lib/http.js';

const EXPECTED_TOOLS = [
  'dsh_answer_question',
  'dsh_approve',
  'dsh_cancel_task',
  'dsh_create_goal',
  'dsh_create_session',
  'dsh_credential_status',
  'dsh_get_result',
  'dsh_get_session',
  'dsh_get_task_status',
  'dsh_health',
  'dsh_list_sessions',
  'dsh_list_workspaces',
  'dsh_pause_goal',
  'dsh_rerun_step',
  'dsh_resume_goal',
  'dsh_retry_step',
  'dsh_revise_goal',
  'dsh_send_message',
  'dsh_start_goal',
  'dsh_stop_goal',
  'dsh_update_goal',
  'dsh_wait_goal',
  'dsh_wait_until_action_required',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitListening(port, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.text();
      return response.status;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw last ?? new Error(`port ${port} never accepted connections`);
}

async function waitClosed(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 40));
    } catch {
      return;
    }
  }
  throw new Error(`port ${port} still accepted connections after close`);
}

function pluginCtx() {
  const disposers = [];
  const services = {
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  return {
    disposers,
    ctx: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get: (key) => services[key],
      agents: services.agents,
      sessions: services.sessions,
      sessionPersistence: services.sessionPersistence,
      agentDefaultModel: services.agentDefaultModel,
      on: () => () => true,
      inject: () => ({}),
      effect: (execute) => {
        const disposer = execute();
        disposers.push(disposer);
        return disposer;
      },
    },
  };
}

test('shipped plugin entry exports name, apply, and Config', async () => {
  assert.equal(name, 'chatgpt-bridge');
  assert.equal(typeof apply, 'function');
  assert.ok(Config);
});

test('createMcpServer registers all public dsh_* tools (v0.5.0)', () => {
  const server = createMcpServer(
    {},
    { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const names = Object.keys(server._registeredTools).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  assert.equal(names.length, 23);
});

test('package clean script is ESM-safe under type:module', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.type, 'module');
  assert.match(manifest.scripts.clean, /import\s*\{[^}]*rmSync/);
  assert.doesNotMatch(manifest.scripts.clean, /\brequire\s*\(/);
});

test('shared DSH host contracts are peers instead of ordinary dependencies', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const sharedHostPackages = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-presets',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-title',
    '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-user-questions',
    '@deepseek-ai/dsh-workspace',
  ];

  for (const packageName of sharedHostPackages) {
    assert.equal(manifest.dependencies?.[packageName], undefined, `${packageName} must not be in dependencies`);
    assert.equal(typeof manifest.peerDependencies?.[packageName], 'string', `${packageName} must be in peerDependencies`);
    assert.equal(typeof manifest.devDependencies?.[packageName], 'string', `${packageName} must be in devDependencies`);
  }
});

test('package manifest targets the verified DSH 0.1.5-rc.2 family', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const [packageName] of Object.entries(manifest.dependencies ?? {})) {
    assert.equal(
      packageName.startsWith('@deepseek-ai/dsh-'),
      false,
      `DSH core package ${packageName} must never be in dependencies`,
    );
  }
  for (const [packageName, version] of Object.entries(manifest.devDependencies ?? {})) {
    if (packageName.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.1.5-rc.2', `devDependencies.${packageName}`);
  }
  for (const [packageName, version] of Object.entries(manifest.peerDependencies ?? {})) {
    if (packageName.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '^0.1.5-rc.2', `peerDependencies.${packageName}`);
  }
});

test('package.json and package-lock.json carry the same release version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));

  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages?.['']?.version, manifest.version);
});

test('test runner selects the Node 22 isolation spelling before running the suite', () => {
  const runner = readFileSync(new URL('../../scripts/test.mjs', import.meta.url), 'utf8');
  assert.match(runner, /nodeMajor === 22\s*\?\s*['"]--experimental-test-isolation=none['"]/);
  assert.doesNotMatch(runner, /result\.status\s*===\s*9/);
});

test('current README and Goal dogfood stay aligned with the shipped control-plane surface', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const dogfood = readFileSync(new URL('../../scripts/goal-control-dogfood.mjs', import.meta.url), 'utf8');

  assert.match(readme, new RegExp(`v${manifest.version.replaceAll('.', '\\.')}`));
  assert.match(readme, /tool count = 23/);
  assert.match(dogfood, new RegExp(`version:\\s*['"]${manifest.version.replaceAll('.', '\\.')}['"]`));
  assert.match(dogfood, /dsh_create_goal/);
  assert.match(dogfood, /dsh_wait_until_action_required/);
});

test('startHttpServer.close stops accepting connections', async () => {
  const port = await freePort();
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const handle = await startHttpServer(
    () => createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log),
    { host: '127.0.0.1', port, authMode: 'none', authToken: '' },
    log,
  );
  try {
    const status = await waitListening(handle.port);
    assert.equal(typeof status, 'number');
    await handle.close();
    await waitClosed(handle.port);
  } catch (error) {
    try { await handle.close(); } catch { /* already closed or failed to start */ }
    throw error;
  }
});

test('apply effect disposer waits for HTTP close', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-apply-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const port = await freePort();
  const { ctx, disposers } = pluginCtx();
  try {
    apply(ctx, {
      transport: 'http',
      host: '127.0.0.1',
      port,
      authMode: 'none',
      logLevel: 'error',
    });
    assert.ok(disposers.length >= 1);
    await waitListening(port);
    for (const disposer of [...disposers].reverse()) {
      await disposer();
    }
    await waitClosed(port);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
