/**
 * Native Settings client render smoke test + ModuleLoader React dependency.
 *
 * The first regression this guards: Section()/Row() were being invoked as
 * plain function calls (`Section({ title }, child, child)`), so the trailing
 * children landed in positional parameters while the components only read
 * `props.children` — the sections rendered as bare titles with NO children.
 *
 * The second: the production client referenced a global `React` that DSH's
 * ModuleLoader never installs. Settings.section registered, but BridgeSection
 * crashed with `ReferenceError: React is not defined`. React MUST come from
 * `factory(require)` → `require('react')`.
 *
 * This test loads the built module-loader artifact (lib/client.js), renders
 * the section through a minimal hand-rolled React (no jsdom, no bundler, no
 * new dependencies), resolves the element tree and asserts the children are
 * ACTUALLY present (status lines, Tunnel ID / Executable inputs, Runtime API
 * Key control, proxy, Save/Start/Restart/Stop/Diagnostics...).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// --------------------------------------------------------------------- React
// Minimal fake React: createElement keeps children in props.children and the
// hooks just return their initial value / no-op. Good enough to build and
// resolve the BridgeSection element tree.
function createElement(type, props, ...children) {
  if (children.length > 0) {
    return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } };
  }
  return { type, props: props ?? {} };
}

const useState = (initial) => [initial, () => {}];
const useCallback = (fn) => fn;
const useEffect = () => {};
const useRef = (initial) => ({ current: initial });

const fakeReact = { createElement, useState, useCallback, useEffect, useRef };

// The real DSH web shell does not install window.React / globalThis.React.
// The test must reproduce that: React is only available through factory
// require('react'). Installing a global here would hide the production bug.
delete globalThis.React;
if (typeof globalThis.window !== 'undefined') {
  delete globalThis.window.React;
}

const requiredIds = [];
let capturedEntry;

function createFakeRequire() {
  return (id) => {
    requiredIds.push(id);
    if (id === 'react') {
      return fakeReact;
    }
    throw new Error(`Unexpected client require: ${id}`);
  };
}

globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      capturedEntry = entry;
      globalThis.window.__dshClientExports = entry.factory(createFakeRequire());
    },
  },
};

await import('../../lib/client.js');
const {
  apply,
  Section,
  Row,
  BridgeSection,
  formFromConfigPayload,
  shouldApplyServerForm,
  openaiDisplayStatus,
  resolveSecretDraft,
  tStatus,
  dictionaries,
} = globalThis.window.__dshClientExports;

after(() => {
  delete globalThis.window;
  delete globalThis.React;
});

// --------------------------------------------------------------------- i18n
const EN = {
  intro: 'Configure the OpenAI tunnel and the plugin-owned tunnel-client runtime.',
  status: 'Status', overall: 'Overall', bridge: 'Bridge', tunnel: 'Tunnel',
  openai: 'OpenAI Control Plane', openaiSection: 'OpenAI access',
  endpoint: 'Endpoint', tunnelClient: 'Tunnel Client', notInstalled: 'Not installed',
  installed: 'Installed',
  tunnelId: 'Tunnel ID', runtimeKey: 'Runtime API Key', configured: 'configured',
  replace: 'Replace', clear: 'Clear',
  save: 'Save', start: 'Start', restart: 'Restart', stop: 'Stop', diagnostics: 'Run diagnostics',
  diagnosticsTitle: 'Diagnostics',
  logs: 'Logs', autoStart: 'Auto start with DSH', proxy: 'Proxy', enableProxy: 'Enable proxy',
  host: 'Host', port: 'Port', controlPlane: 'OpenAI control plane base URL',
  executable: 'Executable path (optional)', configureFirst: 'Fill in Tunnel ID and Runtime API Key, then Start.',
  notConfigured: 'not configured', unsaved: 'Unsaved changes — click Save to persist.',
  runningExternal: 'running (external)',
  externalHint: 'Observed an already-running tunnel-client. This plugin did not start it and will not stop it.',
};
const t = (key) => EN[key] ?? key;

// ------------------------------------------------------------------ resolve
function collect(element, out) {
  if (element === null || element === undefined || typeof element === 'boolean') return;
  if (Array.isArray(element)) {
    for (const child of element) collect(child, out);
    return;
  }
  if (typeof element === 'string' || typeof element === 'number') {
    out.push({ kind: 'text', text: String(element) });
    return;
  }
  if (typeof element !== 'object') return;
  const { type, props } = element;
  if (typeof type === 'function') {
    collect(type(props), out);
    return;
  }
  out.push({ kind: 'element', tag: type, props: props ?? {} });
  collect(props?.children, out);
}

function renderTree(root) {
  const facts = [];
  collect(root, facts);
  return facts;
}

const hasText = (facts, text) => facts.some((f) => f.kind === 'text' && f.text === text);
const findInput = (facts, matcher) => facts.some((f) => f.kind === 'element' && f.tag === 'input' && matcher(f.props));
const inputCount = (facts, matcher) => facts.filter((f) => f.kind === 'element' && f.tag === 'input' && matcher(f.props)).length;
const findButton = (facts, label) =>
  facts.some(
    (f) =>
      f.kind === 'element' &&
      f.tag === 'button' &&
      (f.props.children === label || (Array.isArray(f.props.children) && f.props.children.length === 1 && f.props.children[0] === label)),
  );

function assertBridgeSectionChildren(facts) {
  // Status lines are Section children — they vanished with the plain-call bug.
  for (const label of ['Overall', 'Bridge', 'Tunnel', 'OpenAI Control Plane']) {
    assert.equal(hasText(facts, label), true, `status label "${label}" must be rendered`);
  }
  // Status values (defaults with no snapshot yet). OpenAI is "not configured"
  // rather than "unknown"/"error" because no Runtime API key is loaded.
  for (const value of ['stopped', 'offline', 'not configured']) {
    assert.equal(hasText(facts, value), true, `status value "${value}" must be rendered`);
  }

  // Tunnel Client section: Tunnel ID is write-only (masked, never echoed).
  assert.equal(
    findInput(facts, (p) => p.placeholder === 'tunnel_...' && p.type === 'password' && p.value === ''),
    true,
    'Tunnel ID input must render masked and empty by default',
  );
  assert.equal(findInput(facts, (p) => p.placeholder === 'auto'), true, 'Executable input must render');
  // Auto-start + proxy enable checkboxes are Row children too.
  assert.equal(inputCount(facts, (p) => p.type === 'checkbox') >= 2, true, 'Auto-start and proxy checkboxes must render');

  // OpenAI section: write-only key control + Replace/Clear buttons.
  assert.equal(findInput(facts, (p) => p.type === 'password'), true, 'Runtime API Key input must render');
  assert.equal(hasText(facts, 'Runtime API Key'), true, 'Runtime API Key label must render');

  // Proxy section.
  assert.equal(hasText(facts, 'Proxy'), true, 'Proxy section must render');
  assert.equal(hasText(facts, 'Enable proxy'), true, 'Proxy enable checkbox label must render');

  // Actions + diagnostics + logs.
  for (const label of ['Save', 'Start', 'Restart', 'Stop', 'Run diagnostics', 'Logs', 'Replace', 'Clear']) {
    assert.equal(findButton(facts, label), true, `button "${label}" must render`);
  }
}

// ---------------------------------------------------------------- assertions
test('client: factory requires react from ModuleLoader', () => {
  assert.ok(capturedEntry, 'ModuleLoader must capture the client entry');
  assert.ok(requiredIds.includes('react'), "client factory must require('react')");

  const freshIds = [];
  capturedEntry.factory((id) => {
    freshIds.push(id);
    if (id === 'react') return fakeReact;
    throw new Error(`Unexpected client require: ${id}`);
  });
  assert.ok(freshIds.includes('react'), "re-invoked factory must still require('react')");
});

test('client: no global React is required to load or render', () => {
  assert.equal(globalThis.React, undefined, 'globalThis.React must stay undefined');
  if (typeof globalThis.window !== 'undefined') {
    assert.equal(globalThis.window.React, undefined, 'window.React must stay undefined');
  }
  const facts = renderTree(fakeReact.createElement(BridgeSection, { t }));
  assert.equal(hasText(facts, 'Overall'), true, 'BridgeSection must render without global React');
});

test('client: missing loader React fails at factory load', () => {
  assert.throws(
    () => {
      capturedEntry.factory((id) => {
        if (id === 'react') throw new Error('module unavailable');
        throw new Error(`Unexpected client require: ${id}`);
      });
    },
    (err) => {
      assert.match(String(err && err.message ? err.message : err), /module unavailable/);
      return true;
    },
  );
});

test('client: Section and Row place children into props.children (regression)', () => {
  const sectionFacts = renderTree(fakeReact.createElement(Section, { title: 'Status' }, 'the-sts-child'));
  assert.equal(hasText(sectionFacts, 'the-sts-child'), true, 'Section must render its children');
  const rowFacts = renderTree(fakeReact.createElement(Row, { label: 'Lbl' }, 'the-row-child'));
  assert.equal(hasText(rowFacts, 'the-row-child'), true, 'Row must render its children');
  const stackedFacts = renderTree(fakeReact.createElement(Row, { label: 'Stacked', stacked: true }, 'the-stacked-child'));
  assert.equal(hasText(stackedFacts, 'the-stacked-child'), true, 'stacked Row must render its children');
});

test('client: BridgeSection renders real children, not bare section titles', () => {
  const facts = renderTree(fakeReact.createElement(BridgeSection, { t }));
  assertBridgeSectionChildren(facts);
  assert.equal(hasText(facts, EN.intro), true, 'section intro must render');
  const page = facts.find((f) => f.kind === 'element' && f.tag === 'div' && f.props.className === 'dcb-page');
  assert.ok(page, 'page root must use the settings layout class');
});

test('client: dirty form is not overwritten by a live config poll', () => {
  assert.equal(shouldApplyServerForm(false, false), true, 'clean form hydrates from the server');
  assert.equal(shouldApplyServerForm(true, false), false, 'unsaved edits survive the 2s poll');
  assert.equal(shouldApplyServerForm(true, true), true, 'Save forces a hydrate');
  assert.equal(shouldApplyServerForm(false, true), true);
});

test('client: unclaimed config overlays discovered proxy and official-profile key', () => {
  const fields = formFromConfigPayload({
    config: {
      tunnel: { autoStart: false, proxy: { enabled: false } },
      openai: {},
      bridge: {},
    },
    secrets: { runtimeApiKeyConfigured: false },
    detection: { installed: true, executablePath: 'D:\\tools\\tunnel-client\\tunnel-client.exe' },
    discovered: {
      proxy: { host: '127.0.0.1', port: 7892, source: 'env' },
      proxyInUse: true,
      tunnelId: 'tunnel_abc',
      runtimeApiKeyAvailable: true,
    },
  });
  assert.equal(fields.proxyEnabled, true, 'HTTP_PROXY / running --http-proxy must show Enable proxy when config is unclaimed');
  assert.equal(fields.keyConfigured, true, 'official-profile api_key presence must show the key as configured');
  assert.equal(fields.proxyHost, '127.0.0.1');
  assert.equal(fields.proxyPort, '7892');
  assert.equal(fields.tunnelId, 'tunnel_abc');
});

test('client: saved proxy.enabled false is not overridden by discovered env', () => {
  const fields = formFromConfigPayload({
    config: {
      tunnel: { tunnelId: 'tunnel_abc', autoStart: false, proxy: { enabled: false } },
      openai: { controlPlaneBaseUrl: 'https://api.openai.com' },
      bridge: {},
    },
    secrets: { runtimeApiKeyConfigured: false },
    detection: { installed: true },
    discovered: { proxy: { host: '127.0.0.1', port: 7892, source: 'env' }, proxyInUse: true, tunnelId: 'tunnel_abc' },
  });
  assert.equal(fields.proxyEnabled, false, 'an explicit saved disable must win over discovery');
});

test('client: empty Tunnel ID replacement keeps the stored id', () => {
  assert.equal(resolveSecretDraft('tunnel_abc', ''), 'tunnel_abc');
  assert.equal(resolveSecretDraft('tunnel_abc', '   '), 'tunnel_abc');
  assert.equal(resolveSecretDraft('tunnel_abc', 'tunnel_new'), 'tunnel_new');
  assert.equal(resolveSecretDraft('', 'tunnel_new'), 'tunnel_new');
  assert.equal(resolveSecretDraft('', ''), '');
});

test('client: OpenAI missing-key is not displayed as error', () => {
  assert.equal(openaiDisplayStatus('error', false), 'notConfigured');
  assert.equal(openaiDisplayStatus('unknown', false), 'notConfigured');
  assert.equal(openaiDisplayStatus('error', true), 'error');
  assert.equal(openaiDisplayStatus('connected', true), 'connected');
  assert.equal(openaiDisplayStatus('unreachable', true), 'unreachable');
});

test('client: zh locale translates status vocabulary; English stays English', () => {
  assert.equal(dictionaries.en.status, 'Status');
  assert.equal(dictionaries.en.overall, 'Overall');
  assert.equal(dictionaries.en.start, 'Start');
  assert.equal(dictionaries.en.stop, 'Stop');
  assert.equal(dictionaries.en.restart, 'Restart');
  assert.equal(dictionaries.en.diagnostics, 'Run diagnostics');
  assert.equal(dictionaries.en.st_running, 'running');
  assert.equal(dictionaries.en.st_stopped, 'stopped');
  assert.equal(dictionaries.zh.status, '状态');
  assert.equal(dictionaries.zh.overall, '总览');
  assert.equal(dictionaries.zh.start, '启动');
  assert.equal(dictionaries.zh.stop, '停止');
  assert.equal(dictionaries.zh.restart, '重启');
  assert.equal(dictionaries.zh.diagnostics, '运行诊断');
  assert.equal(dictionaries.zh.runtimeKey, 'Runtime API Key');
  assert.equal(dictionaries.zh.tunnelId, 'Tunnel ID');
  assert.equal(dictionaries.zh.st_running, '运行中');
  assert.equal(dictionaries.zh.st_stopped, '已停止');
  assert.equal(dictionaries.zh.st_starting, '启动中');
  assert.equal(dictionaries.zh.st_stopping, '停止中');
  assert.equal(dictionaries.zh.st_error, '错误');
  assert.equal(dictionaries.zh.st_unknown, '未知');
  assert.equal(tStatus((key) => dictionaries.zh[key] ?? key, 'running'), '运行中');
  assert.equal(tStatus((key) => dictionaries.en[key] ?? key, 'running'), 'running');
  // Control-plane naming: the top status item is "OpenAI 控制平面" (English
  // "OpenAI Control Plane"), NOT a local "OpenAI 运行时" process.
  assert.equal(dictionaries.zh.openai, 'OpenAI 控制平面');
  assert.equal(dictionaries.en.openai, 'OpenAI Control Plane');
  assert.equal(dictionaries.zh.openaiSection, 'OpenAI 接入');
  assert.equal(dictionaries.en.openaiSection, 'OpenAI access');
  assert.equal(dictionaries.zh.controlPlane, 'OpenAI 控制平面地址');
  assert.equal(dictionaries.en.controlPlane, 'OpenAI control plane base URL');
  assert.equal(
    Object.values(dictionaries.zh).some((v) => v === 'OpenAI 运行时'),
    false,
    'zh dictionary must not name any item "OpenAI 运行时"',
  );
});

test('client: apply registers settings.section exactly once per load and returns a disposer', () => {
  const log = { injects: [], registers: [], localeRegs: [], effects: [] };
  const ctx = {
    effect: (fn, label) => {
      log.effects.push(label);
      const inner = fn();
      return typeof inner === 'function' ? inner : () => {};
    },
    locale: {
      register: (ns, dicts) => {
        log.localeRegs.push([ns, dicts]);
        return () => {};
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (key, cb) => {
        log.injects.push([key, cb]);
        return () => {};
      },
      register: (opts, comp) => {
        log.registers.push([opts, comp]);
        return () => {};
      },
    },
  };

  apply(ctx);

  // One settings.section injection per load — the left-nav row derives from
  // this single registration. A duplicate row can therefore NOT come from this
  // plugin calling slots.inject/register twice.
  assert.equal(log.injects.length, 1, 'apply must call slots.inject exactly once');
  assert.deepEqual(log.injects[0][0], 'settings.section');
  assert.equal(log.localeRegs.length, 1, 'locale dictionaries registered once');

  const cb = log.injects[0][1];
  const disposer = cb();
  assert.equal(log.registers.length, 1, 'the injection callback must register exactly one section');
  const [opts] = log.registers[0];
  assert.equal(opts.name, 'settings.section');
  assert.equal(opts.id, 'chatgpt-bridge');
  assert.equal(opts.order, 66);
  assert.equal(typeof opts.label, 'function');
  assert.equal(typeof opts.inject, 'function');
  assert.equal(typeof disposer, 'function', 'the injection callback must yield a disposer for the shell to run on unload');
});

test('client: proxy checkbox onChange marks the field dirty (does not auto-save)', () => {
  const facts = renderTree(fakeReact.createElement(BridgeSection, { t }));
  const boxes = facts.filter((f) => f.kind === 'element' && f.tag === 'input' && f.props.type === 'checkbox');
  assert.equal(boxes.length >= 2, true);
  const proxyBox = boxes[boxes.length - 1];
  assert.equal(typeof proxyBox.props.onChange, 'function');
  assert.equal(proxyBox.props.checked, false);
});
