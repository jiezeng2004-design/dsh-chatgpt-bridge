#!/usr/bin/env node
/**
 * Self-contained advisor acceptance loop over real loopback Streamable HTTP.
 * Run npm run build first. No DSH/ChatGPT account, user state, or network
 * beyond 127.0.0.1 is needed. Reported unit results below are fake DSH metadata.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BridgeError } from '../lib/bridge.js';
import { resolveConfig } from '../lib/config.js';
import { startHttpServer } from '../lib/http.js';
import { createMcpServer } from '../lib/mcp.js';
import { registerAdvisorAgentTools } from '../lib/advisor/agent-tools.js';
import { ADVISOR_FORBIDDEN_TOOL_NAMES } from '../lib/advisor/mcp-tools.js';
import { createAdvisorRuntime } from '../lib/advisor/runtime.js';

const execute = promisify(execFile);
const token = randomBytes(32).toString('hex');
const fakeSecret = 'sk-dogfoodfake123456';
const expectedTools = [
  'dsh_health', 'dsh_list_workspaces',
  ...['workspace_info', 'list_dir', 'read_file', 'search', 'git_status', 'git_diff',
    'wait_request', 'submit_plan', 'submit_verdict', 'test_status'].map((name) => `dsh_advisor_${name}`),
].sort();
const plan = {
  rationale: 'Implement and review a bounded local change.',
  actions: ['Update the application and add a helper.'],
  files_likely: ['src/app.js', 'src/new.js'], tests: ['unit'],
  success_criteria: ['Review the diff and reported unit status.'],
};
const tests = [{ name: 'unit', status: 'passed' }];
let failures = 0;
let responseCount = 0;
let unsafeResponses = 0;
let tempDir;
let tempParent;
let runtime;
let server;
let client;
let transport;
let disposers = [];

function safeDetail(value) {
  return String(value).replaceAll(token, '[REDACTED_TOKEN]')
    .replace(/sk-dogfood[^\s"'\\]*/g, '[REDACTED_FAKE_SECRET]');
}
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✖ ${name}${detail ? `: ${safeDetail(detail)}` : ''}`);
  }
  return ok;
}
function requireCheck(name, ok, detail = '') {
  if (!check(name, ok, detail)) throw new Error(`Cannot continue after: ${name}`);
}
function inspectResponse(label, value) {
  responseCount++;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.includes('sk-dogfoodfake') || text.includes(token)) {
    unsafeResponses++;
    check(`${label}: response contains no secret or bearer token`, false);
    throw new Error('Unsafe response suppressed.');
  }
}
const log = { debug() {}, info() {}, warn() {}, error() {} };

async function call(name, args = {}, expectedError) {
  const fullName = `dsh_advisor_${name}`;
  const result = await client.callTool({ name: fullName, arguments: args });
  // Inspect every raw MCP text block (including errors), before parsing or printing.
  inspectResponse(fullName, result);
  const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const parsed = JSON.parse(text);
  if (expectedError) {
    check(`${fullName} rejects with ${expectedError}`, result.isError === true && parsed.error?.code === expectedError);
  } else if (result.isError) {
    check(`${fullName} succeeds`, false, parsed.error?.code ?? 'unknown error');
    throw new Error(`${fullName} failed`);
  }
  return parsed;
}

async function stopEndpoint() {
  // Try each resource even when an earlier close fails.
  const errors = [];
  for (const close of [
    async () => { for (const dispose of disposers.splice(0).reverse()) dispose(); },
    async () => { const current = transport; transport = undefined; await current?.terminateSession(); },
    async () => { const current = client; client = undefined; await current?.close(); },
    async () => { const current = server; server = undefined; await current?.close(); },
    async () => { const current = runtime; runtime = undefined; await current?.close(); },
  ]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new Error(`Resource close failed (${errors.length}): ${safeDetail(errors[0])}`);
}

async function startEndpoint(cfg, bridge) {
  runtime = createAdvisorRuntime(cfg, log);
  await runtime.store.load();
  const definitions = new Map();
  const providers = [];
  const injections = [];
  const pending = [];
  const fakeCtx = {
    inject(deps, callback) {
      injections.push(deps.join(','));
      pending.push(Promise.resolve(callback({
        tools: { register(definition) {
          if (definitions.has(definition.name)) throw new Error('Duplicate agent tool.');
          definitions.set(definition.name, definition);
          return () => definitions.delete(definition.name);
        } },
        skills: { registerProvider(factory) {
          const provider = factory();
          providers.push(provider);
          return () => providers.splice(providers.indexOf(provider), 1);
        } },
      })).then((dispose) => { if (typeof dispose === 'function') disposers.push(dispose); }));
    },
  };
  registerAdvisorAgentTools(fakeCtx, runtime, bridge, log);
  await Promise.all(pending);
  requireCheck('DSH tools and bundled skills provider registered through injections',
    JSON.stringify([...definitions.keys()].sort()) === JSON.stringify([
      'advisor_executed', 'advisor_get_plan', 'advisor_handoff', 'advisor_init',
    ]) && injections.join('|') === 'tools|skills'
      && providers.length === 1 && (await providers[0].list())[0]?.name === 'chatgpt-advisor');
  const agent = { id: 'session-dogfood', session: { header: { cwd: tempDir } } };
  const agentCall = async (name, args) => {
    const definition = definitions.get(name);
    const result = await definition.execute(args, { agent });
    inspectResponse(name, result);
    // Exercise the text renderer too, since this is what the DSH agent sees.
    inspectResponse(`${name} rendered`, definition.output.render(args, result));
    return result;
  };
  server = await startHttpServer(() => createMcpServer(bridge, cfg, log, runtime), cfg, log);
  requireCheck('real HTTP server bound to 127.0.0.1 on an ephemeral port',
    new URL(server.url).hostname === '127.0.0.1' && server.port > 0 && cfg.port === 0);
  transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  client = new Client({ name: 'advisor-dogfood', version: '1.0.0' });
  await client.connect(transport);
  return agentCall;
}

async function run() {
  tempParent = await realpath(tmpdir());
  tempDir = await mkdtemp(join(tempParent, 'dsh-advisor-dogfood-'));
  await mkdir(join(tempDir, 'src'));
  await mkdir(join(tempDir, 'private'));
  await writeFile(join(tempDir, 'README.md'), '# Advisor dogfood fixture\n');
  await writeFile(join(tempDir, 'src/app.js'), 'export const answer = 1;\n');
  await writeFile(join(tempDir, '.env'), `API_KEY=${fakeSecret}\n`);
  await writeFile(join(tempDir, '.dshadvisorignore'), 'private/\n');
  await writeFile(join(tempDir, 'private/notes.txt'), 'Private fixture notes.\n');
  // -C keeps the driver cwd unchanged. Ignore user Git config/hooks/signing.
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(tempDir, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(gitEnv)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/.test(key)) delete gitEnv[key];
  }
  await writeFile(gitEnv.GIT_CONFIG_GLOBAL, '');
  const git = (args) => execute('git', ['-C', tempDir, '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', ...args],
    { cwd: process.cwd(), env: gitEnv, windowsHide: true, timeout: 15000 });
  try {
    await git(['init', '-q']);
    await git(['config', '--local', 'user.name', 'Advisor Dogfood']);
    await git(['config', '--local', 'user.email', 'advisor-dogfood@example.invalid']);
    await git(['config', '--local', 'core.autocrlf', 'false']);
    await git(['add', '--', 'README.md', 'src/app.js', '.env', '.dshadvisorignore', 'private/notes.txt']);
    await git(['commit', '-q', '-m', 'Advisor dogfood baseline']);
    requireCheck('temporary Git workspace committed', /^[a-f0-9]{40,64}$/.test((await git(['rev-parse', 'HEAD'])).stdout.trim()));
  } catch (error) {
    if (error.code === 'EPERM') {
      check('temporary Git workspace setup', false, 'EPERM: sandbox refused Git subprocess; dependent acceptance checks could not run');
      throw new Error('Git setup blocked by EPERM; no acceptance checks were relaxed.');
    }
    throw error;
  }

  const workspace = { id: 'dogfood-workspace', title: 'Advisor dogfood', path: tempDir };
  const bridge = {
    async resolveWorkspace(value) {
      if ([workspace.id, workspace.title, workspace.path].includes(value)) return workspace;
      throw new BridgeError('WORKSPACE_NOT_FOUND', 'No registered workspace matches the reference.');
    },
    async listWorkspaces() { return [workspace]; },
    async health() { return { status: 'ok', mode: 'advisor' }; },
  };
  const cfg = resolveConfig({ mode: 'advisor', authMode: 'token', authToken: token,
    host: '127.0.0.1', port: 0, advisorMaxIterations: 3 }, { DSH_HOME: tempDir });
  requireCheck('config and persisted advisor state isolated in temporary directory',
    cfg.dshHome === tempDir && cfg.tokenFile === join(tempDir, 'chatgpt-bridge.token'));
  let agentCall = await startEndpoint(cfg, bridge);
  const listed = await client.listTools();
  inspectResponse('tools/list', listed);
  check('tools/list exposes exactly the 12 expected advisor-mode tools',
    JSON.stringify(listed.tools.map((tool) => tool.name).sort()) === JSON.stringify(expectedTools));
  check('tools/list excludes every forbidden controller tool',
    listed.tools.every((tool) => !ADVISOR_FORBIDDEN_TOOL_NAMES.includes(tool.name)));
  for (const [label, authorization] of [['missing', undefined], ['incorrect', 'Bearer invalid-dogfood-token']]) {
    const response = await fetch(server.url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: AbortSignal.timeout(5000) });
    inspectResponse(`${label} auth response`, await response.text());
    check(`${label} bearer token receives HTTP 401`, response.status === 401);
  }
  const registered = await client.callTool({ name: 'dsh_list_workspaces', arguments: {} });
  inspectResponse('dsh_list_workspaces', registered);
  check('fake bridge exposes only the temporary workspace', !registered.isError
    && JSON.parse(registered.content[0].text).length === 1
    && JSON.parse(registered.content[0].text)[0].path === tempDir);
  const health = await client.callTool({ name: 'dsh_health', arguments: {} });
  inspectResponse('dsh_health', health);
  check('health tool succeeds over HTTP', !health.isError && JSON.parse(health.content[0].text).status === 'ok');

  const initial = await agentCall('advisor_init', { goal: 'Update the fixture and review execution.' });
  const task_id = initial.task_id;
  requireCheck('DSH advisor_init resolves workspace from agent cwd', /^adv_[a-f0-9]{16}$/.test(task_id)
    && initial.state === 'INIT' && (await runtime.store.getTask(task_id)).workspace_id === workspace.id);
  const wait = (id) => call('wait_request', { task_id: id, wait_seconds: 1 });
  const getPlan = (id) => agentCall('advisor_get_plan', { task_id: id, wait_seconds: 1 });
  const report = (id, iteration, changed_files_count = 0) => agentCall('advisor_executed', {
    task_id: id, iteration, changed_files_count, tests, summary: 'Simulated DSH execution; reported unit status passed.',
  });
  const initRequest = await wait(task_id);
  check('ChatGPT wait_request receives INIT and continuation guidance', initRequest.request?.kind === 'INIT'
    && initRequest.request.task_id === task_id && initRequest.continuation_required === true
    && initRequest.next_tool_call === 'dsh_advisor_submit_plan');
  const info = await call('workspace_info', { workspace: workspace.id });
  check('workspace_info reports temporary Git identity', info.id === workspace.id && info.is_git_repo === true && !!info.head);
  const dir = await call('list_dir', { workspace: workspace.id, depth: 3 });
  check('list_dir hides .env and private/ with hidden_count > 0', dir.hidden_count > 0
    && dir.entries.some((entry) => entry.path === 'src/app.js')
    && dir.entries.every((entry) => entry.path !== '.env' && !/^private(?:\/|$)/.test(entry.path)));
  const source = await call('read_file', { workspace: workspace.id, path: 'src/app.js' });
  check('read_file returns src/app.js', source.content === 'export const answer = 1;');
  await call('read_file', { workspace: workspace.id, path: '.env' }, 'SENSITIVE_PATH');
  const search = await call('search', { workspace: workspace.id, query: 'sk-dogfood' });
  check('search excludes the secret in .env', Array.isArray(search.matches) && search.matches.length === 0);
  await call('read_file', { workspace: workspace.id, path: '../outside' }, 'PATH_OUTSIDE_WORKSPACE');

  const submitted = await call('submit_plan', { task_id, iteration: 1, ...plan });
  check('ChatGPT submits iteration 1 plan', submitted.state === 'PLAN' && submitted.iteration === 1 && submitted.continuation_required === true);
  const received = await getPlan(task_id);
  requireCheck('DSH gets iteration 1 plan', received.iteration === 1 && JSON.stringify(received.plan) === JSON.stringify(plan));
  await writeFile(join(tempDir, 'src/app.js'), 'export const answer = 2;\n// dogfood application change\n');
  await writeFile(join(tempDir, 'src/new.js'), 'export const helper = true;\n');
  await writeFile(join(tempDir, '.env'), `API_KEY=${fakeSecret}-changed\n`);
  const executed = await report(task_id, 1, 3);
  check('DSH reports iteration 1 execution and three changed files', executed.state === 'EXECUTED'
    && executed.last_executed?.changed_files_count === 3);
  const request = await wait(task_id);
  check('ChatGPT receives EXECUTED for iteration 1', request.request?.kind === 'EXECUTED'
    && request.request.iteration === 1 && request.next_tool_call === 'dsh_advisor_submit_verdict');
  const status = await call('git_status', { workspace: workspace.id });
  check('git_status includes app/new files and hides modified .env', status.hidden_count >= 1
    && ['src/app.js', 'src/new.js'].every((path) => status.entries.some((entry) => entry.path === path))
    && status.entries.every((entry) => entry.path !== '.env'));
  const diff = await call('git_diff', { workspace: workspace.id });
  check('git_diff contains app change and omits .env section and secret', diff.diff.includes('+export const answer = 2;')
    && diff.diff.includes('diff --git a/src/app.js b/src/app.js') && !diff.diff.includes('.env')
    && !diff.diff.includes('sk-dogfood') && diff.hidden_files >= 1);
  let offset = 0;
  const pages = [];
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await call('git_diff', { workspace: workspace.id, offset, max_bytes: 37 });
    requireCheck(`git_diff page ${pageNumber + 1} respects byte offsets and filtering`, page.offset === offset
      && Buffer.byteLength(page.diff) <= 37 && page.total_bytes === diff.total_bytes
      && page.hidden_files >= 1 && !page.diff.includes('sk-dogfood') && !page.diff.includes('.env'));
    pages.push(page.diff);
    if (page.next_offset === null) break;
    requireCheck(`git_diff page ${pageNumber + 1} advances`, Number.isInteger(page.next_offset)
      && page.next_offset === offset + Buffer.byteLength(page.diff) && page.next_offset > offset && page.truncated === true);
    offset = page.next_offset;
  }
  check('small git_diff pages reassemble the complete filtered diff', pages.length > 1
    && pages.join('') === diff.diff && Buffer.byteLength(pages.join('')) === diff.total_bytes);
  const testStatus = await call('test_status', { task_id });
  check('test_status returns reported tests and changed-files count', testStatus.state === 'EXECUTED'
    && JSON.stringify(testStatus.last_executed?.tests) === JSON.stringify(tests)
    && testStatus.last_executed.changed_files_count === 3);
  const next = await call('submit_verdict', { task_id, iteration: 1, verdict: 'plan', plan });
  check('plan verdict advances to iteration 2', next.state === 'PLAN' && next.iteration === 2 && next.continuation_required === true);
  requireCheck('DSH gets iteration 2 plan', (await getPlan(task_id)).iteration === 2);
  await report(task_id, 2);
  check('ChatGPT receives iteration 2 EXECUTED', (await wait(task_id)).request?.iteration === 2);
  const done = await call('submit_verdict', { task_id, iteration: 2, verdict: 'done' });
  const terminal = await getPlan(task_id);
  check('done verdict is terminal for ChatGPT and DSH', done.state === 'DONE' && done.continuation_required === false
    && terminal.terminal === true && terminal.verdict === 'done' && terminal.state === 'DONE');
  const idle = await wait(task_id);
  check('short idle wait preserves continuation guidance', idle.idle === true && idle.continuation_required === true
    && idle.next_tool_call === 'dsh_advisor_wait_request');

  const limited = await agentCall('advisor_init', { goal: 'Exercise the configured iteration limit.' });
  check('second task starts after terminal done', limited.state === 'INIT' && limited.task_id !== task_id);
  await call('submit_plan', { task_id: limited.task_id, iteration: 1, ...plan });
  for (let iteration = 1; iteration <= 3; iteration++) {
    requireCheck(`limit task: DSH receives iteration ${iteration}`, (await getPlan(limited.task_id)).iteration === iteration);
    await report(limited.task_id, iteration);
    const pending = await wait(limited.task_id);
    check(`limit task: ChatGPT receives EXECUTED ${iteration}`, pending.request?.kind === 'EXECUTED' && pending.request.iteration === iteration);
    const verdict = await call('submit_verdict', { task_id: limited.task_id, iteration, verdict: 'plan', plan });
    if (iteration < 3) check(`limit task: plan advances to ${iteration + 1}`, verdict.state === 'PLAN' && verdict.iteration === iteration + 1);
    else check('plan at configured limit 3 ends BLOCKED iteration_limit', verdict.state === 'BLOCKED'
      && verdict.iteration === 3 && verdict.max_iterations === 3 && verdict.blocked_reason === 'iteration_limit'
      && verdict.continuation_required === false);
  }
  const blocked = await getPlan(limited.task_id);
  check('DSH receives terminal iteration_limit', blocked.terminal === true && blocked.state === 'BLOCKED' && blocked.blocked_reason === 'iteration_limit');

  const restart = await agentCall('advisor_init', { goal: 'Persist an EXECUTED checkpoint across restart.' });
  await call('submit_plan', { task_id: restart.task_id, iteration: 1, ...plan });
  await getPlan(restart.task_id);
  await report(restart.task_id, 1, 3);
  await stopEndpoint();
  agentCall = await startEndpoint(cfg, bridge);
  const restored = await wait(restart.task_id);
  check('restart on same state dir returns persisted EXECUTED over fresh HTTP client',
    restored.request?.task_id === restart.task_id && restored.request.kind === 'EXECUTED'
    && restored.request.iteration === 1 && restored.request.last_executed?.changed_files_count === 3
    && JSON.stringify(restored.request.last_executed.tests) === JSON.stringify(tests));
  await call('submit_verdict', { task_id: restart.task_id, iteration: 1, verdict: 'done' });
  check('DSH receives terminal done after restart', (await agentCall('advisor_get_plan', {
    task_id: restart.task_id, wait_seconds: 1,
  })).verdict === 'done');
}

async function cleanup() {
  try { await stopEndpoint(); check('client, server, runtime and registrations closed', true); }
  catch (error) { check('client, server, runtime and registrations closed', false, error); }
  if (tempDir) {
    try {
      // Delete only the single directory returned by mkdtemp, never a link/root.
      const target = resolve(tempDir);
      const info = await lstat(target);
      const child = relative(tempParent, target);
      if (dirname(target) !== tempParent || !child.startsWith('dsh-advisor-dogfood-')
        || isAbsolute(child) || child.startsWith('..') || !info.isDirectory() || info.isSymbolicLink()
        || await realpath(target) !== target) throw new Error('Temporary directory boundary validation failed.');
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      check('owned temporary workspace and state deleted', true);
    } catch (error) { check('owned temporary workspace and state deleted', false, error); }
  }
}

console.log('dsh-chatgpt-bridge advisor dogfooding (real loopback Streamable HTTP)');
// Reserve ten seconds for cleanup; force exit at 120 seconds even if IO hangs.
const watchdog = setTimeout(() => {
  check('hard overall timeout (120 seconds)', false);
  process.exit(1);
}, 120000);
let deadline;
try {
  await Promise.race([run(), new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('110-second execution deadline exceeded; cleaning up.')), 110000);
  })]);
} catch (error) {
  check('advisor acceptance run completed', false, error instanceof Error ? error.message : error);
} finally {
  clearTimeout(deadline);
  await cleanup();
  check(`tool/protocol responses checked for fake secret and bearer token (${responseCount} responses)`,
    responseCount > 0 && unsafeResponses === 0,
    responseCount === 0 ? 'Unverified: acceptance run stopped before any tool/protocol response.' : '');
  clearTimeout(watchdog);
}
console.log('\n==== advisor dogfood summary ====');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
