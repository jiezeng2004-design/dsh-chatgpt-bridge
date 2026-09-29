// Run only in a disposable copy with the official CLI installed. No real profile,
// credentials, model calls, tunnel or browser state is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('isolated official Web CLI loads bridge, preserves auth/origin and serves MCP tools', { timeout: 60000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-dsh-cli-'));
  const webPort = await freePort();
  const bridgePort = await freePort();
  const token = randomBytes(24).toString('hex');
  const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
  const overlay = join(home, 'compat.patch.yml');
  const profile = join(home, 'profiles/web');
  await mkdir(profile, { recursive: true });
  // No profile package installation and no dependency on a user's home.
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-web', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(overlay, [
    '- id: llm-deepseek\n  disabled: true',
    '- id: llm-pi-ai\n  disabled: true',
    '- id: session-title-llm\n  disabled: true',
    '- id: agent-preset-registry\n  config:\n    default: bridge-contract',
    '- insert:',
    '    - id: bridge-contract-fixture',
    `      name: ${JSON.stringify(fileURLToPath(new URL('./host-fixture.mjs', import.meta.url)).replaceAll('\\', '/'))}`,
    '    - id: chatgpt-bridge',
    `      name: ${JSON.stringify(fileURLToPath(new URL('../../lib/index.js', import.meta.url)).replaceAll('\\', '/'))}`,
    '      config:',
    '        transport: http',
    '        host: 127.0.0.1',
    `        port: ${bridgePort}`,
    '        authMode: token',
    '        authTokenEnv: BRIDGE_TEST_TOKEN',
    '        logLevel: error',
  ].join('\n') + '\n');
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { DSH_HOME: home, USERPROFILE: home, HOME: home, BRIDGE_TEST_TOKEN: token, DSH_TELEMETRY_DISABLED: '1' });
  let output = '';
  let exited = false;
  const child = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', String(webPort), '--no-open'],
    { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('exit', () => { exited = true; });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const client = new Client({ name: 'isolated-bridge-contract', version: '1.0.0' });
  const bridgeUrl = `http://127.0.0.1:${bridgePort}/mcp`;
  let stage = 'bridge readiness';
  try {
    let ready = false;
    const until = Date.now() + 45000;
    while (Date.now() < until && !exited) {
      // A listener can appear while the Loader is still settling and remounting
      // services. The official ready announcement waits for that barrier.
      if (!output.includes('dsh web:')) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      try {
        const response = await fetch(bridgeUrl, { headers: { connection: 'close' }, signal: AbortSignal.timeout(500) });
        await response.arrayBuffer();
        if (response.status === 401) { ready = true; break; }
      } catch { /* waiting for the owned child only */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Diagnostics redact both synthetic auth values and any login URLs.
    assert.ok(ready, `isolated startup failed: ${output.replaceAll(token, '[REDACTED]').replace(/https?:\/\/[^\s]+/g, '[URL]').slice(-5000)}`);
    // Origin checks belong to the same-origin Web management plane; MCP uses
    // its independent bearer-authenticated cross-origin transport.
    stage = 'management Origin fence';
    const badOrigin = await fetch(`http://127.0.0.1:${webPort}/_dsh/chatgpt-bridge/config`, { method: 'PUT', headers: {
      origin: 'https://untrusted.invalid', 'content-type': 'application/json', 'x-dsh-chatgpt-bridge': '1',
    }, body: '{}' });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error, 'bad-origin');
    stage = 'MCP initialize';
    await client.connect(new StreamableHTTPClientTransport(new URL(bridgeUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => {
        const method = init?.body ? JSON.parse(init.body).method : init?.method;
        output += `MCP request ${method}\n`;
        const response = await fetch(url, init);
        output += `MCP response ${method} ${response.status}\n`;
        return response;
      },
    }));
    stage = 'MCP tools/list';
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 23);
    stage = 'MCP health';
    const health = await client.callTool({ name: 'dsh_health', arguments: {} });
    assert.notEqual(health.isError, true);
    const resultOf = result => {
      assert.notEqual(result.isError, true);
      return JSON.parse(result.content.find(item => item.type === 'text').text);
    };
    const healthData = resultOf(health);
    assert.equal(healthData.bridge.version, require('../../package.json').version);
    assert.equal(healthData.dsh.version, require('@deepseek-ai/dsh/package.json').version);
    assert.equal(healthData.capabilities.agentPresets, true);
    assert.equal(healthData.capabilities.webSurface, true);
    assert.equal(healthData.capabilities.userQuestions, true);
    stage = 'MCP create with real preset registry';
    const created = resultOf(await client.callTool({ name: 'dsh_create_session', arguments: {
      workspace: 'Bridge contract workspace', title: 'Isolated preset contract',
    } }));
    assert.ok(created.session_id);
    assert.equal(created.status, 'idle');
    stage = 'MCP get created session';
    const view = resultOf(await client.callTool({ name: 'dsh_get_session', arguments: { session_id: created.session_id } }));
    assert.equal(view.session_id, created.session_id);
    assert.equal(view.title, 'Isolated preset contract');
    stage = 'Web HTML';
    const unauthenticated = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(3000) });
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.arrayBuffer();
    const launchUrl = output.match(/dsh web: (http:\/\/\S+)/)?.[1];
    assert.ok(launchUrl, 'official ready announcement includes a test login URL');
    const login = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'test login sets a browser session cookie');
    await login.arrayBuffer();
    const page = await fetch(`http://127.0.0.1:${webPort}/`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
  } catch (error) {
    output += await readFile(join(home, 'chatgpt-bridge.log'), 'utf8').catch(() => '');
    throw new Error(`${stage}: ${error.message}; host exited=${exited}; ${output.replaceAll(token, '[REDACTED]').replace(/https?:\/\/[^\s]+/g, '[URL]').slice(-5000)}`, { cause: error });
  } finally {
    await client.close().catch(() => {});
    if (!exited) {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }
    await rm(home, { recursive: true, force: true });
  }
  await assert.rejects(fetch(bridgeUrl, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(1000) }));
});
