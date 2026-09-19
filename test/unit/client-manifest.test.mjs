/**
 * Client module graph regression gate - DSH 0.1.1 Client architecture.
 *
 * DSH's client module system distinguishes TWO injects and this suite pins the
 * boundary so neither drifts:
 *
 *   1. Package-level graph edge  (package.json -> dsh.client.inject)
 *      Module-graph metadata driving the client loader's prefetch /
 *      inject-waiting. It must name packages that actually declare a
 *      `dsh.client` manifest (they contribute a graph row + bundle).
 *
 *   2. Browser service inject    (const inject = ['slots', 'locale'])
 *      The Cordis fiber's runtime SERVICE dependencies, resolved at activation
 *      through the framework-provided `slots` / `locale` services.
 *
 * The bridge must keep the SECOND (slots + locale are real runtime services the
 * plugin consumes) and must NOT declare the legacy package edge
 * `@deepseek-ai/dsh-client-ui-slots`: in 0.1.1 that package is a pure library
 * (exports only SlotCore registry primitives, has no `dsh.client` declaration
 * and no exports["./client"]), so it never registers a graph row - a
 * `dsh.client.inject` entry pointing at it would make the loader wait on a
 * module that never composes. No official 0.1.1 client plugin (runtime,
 * locale, ui-settings, ui-theme, ui-plan, ui-workspace, ui-agent-preset)
 * lists it in dsh.client.inject.
 *
 * The browser inject and the settings.section registration must stay exactly
 * as they are: they are the supported 0.1.1 contract (cf.
 * dsh-client-ui-theme `ctx.slots.inject("settings.general.item", ...)` and
 * dsh-client-ui-agent-preset registering the same `settings.section` slot).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const srcClient = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8');
const libClient = readFileSync(join(root, 'lib', 'client.js'), 'utf8');

// Parse the browser-level `const inject = [...]` literal tolerantly (no regex,
// semantics over formatting): returns the service names in the array.
function browserInjectNames(code) {
  const needle = 'const inject = [';
  const start = code.indexOf(needle);
  assert.ok(start >= 0, 'browser client must declare a const inject array');
  const open = start + needle.length;
  const close = code.indexOf(']', open);
  assert.ok(close > open, 'browser inject array must be closed');
  return code.slice(open, close).split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

// ------------------------------------------------------------------
// 1. Package manifest
test('client manifest: platform is web', () => {
  assert.equal(manifest.dsh.client.platform, 'web');
});

test('client manifest: dsh.client.inject keeps the real graph deps and NOT the legacy ui-slots edge', () => {
  const inject = manifest.dsh.client.inject;
  assert.ok(Array.isArray(inject), 'dsh.client.inject must be a string array');
  const graphModules = [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
  ];
  assert.deepEqual(inject, graphModules, 'client inject must contain exactly the verified rc.2 graph modules');
  assert.equal(
    inject.includes('@deepseek-ai/dsh-client-ui-slots'),
    false,
    'ui-slots is a library, not a client graph module; a dsh.client.inject edge to it waits on a module that never registers',
  );
});

// ------------------------------------------------------------------
// 2. Browser service dependency
test('client source: browser service inject keeps slots + locale in src and built bundle', () => {
  for (const [label, code] of [['src/client/index.js', srcClient], ['lib/client.js', libClient]]) {
    const names = browserInjectNames(code);
    assert.ok(names.includes('slots'), label + ' browser inject must include the slots service');
    assert.ok(names.includes('locale'), label + ' browser inject must include the locale service');
    assert.ok(
      names.every((n) => !n.startsWith('@deepseek-ai/')),
      label + ' browser inject must list services, never package names (got: ' + names.join(',') + ')',
    );
  }
});

// ------------------------------------------------------------------
// 3. Slot registration through the slots SERVICE
test('client source: settings.section is still registered through ctx.slots (src + built bundle)', () => {
  for (const [label, code] of [['src/client/index.js', srcClient], ['lib/client.js', libClient]]) {
    assert.ok(
      code.includes("ctx.slots.inject('settings.section'"),
      label + ' must inject the settings.section slot through ctx.slots',
    );
    assert.ok(code.includes('ctx.slots.register('), label + ' must register through ctx.slots.register');
  }
});

// ------------------------------------------------------------------
// 4. Behaviour: load the BUILT module-loader artifact and apply it against a
// stubbed shell. The bridge must register exactly one settings section through
// ctx.slots - proving the section still activates with no ui-slots package
// edge anywhere in the loop.
test('client build: applying the bundle registers exactly one settings.section via ctx.slots', () => {
  let entry;
  const sandbox = {
    window: { __ModuleLoader__: { load: (e) => { entry = e; } } },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(libClient, sandbox, { filename: 'lib/client.js' });
  assert.ok(entry && typeof entry.factory === 'function', 'bundle must register a module-loader entry');
  assert.equal(entry.id, 'dsh-chatgpt-bridge');

  const fakeReact = {
    createElement: () => ({ tag: 'react' }),
    useState: (v) => [v, () => {}],
    useCallback: (f) => f,
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  };
  const bundle = entry.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error('unexpected client require: ' + id);
  });
  assert.ok(bundle.inject.includes('slots') && bundle.inject.includes('locale'));
  assert.equal(typeof bundle.apply, 'function');

  const log = { injects: [], registers: [] };
  const ctx = {
    effect: (fn) => { const r = fn(); return typeof r === 'function' ? r : () => {}; },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (key, cb) => { log.injects.push([key, cb]); return () => {}; },
      register: (opts) => { log.registers.push(opts); return () => {}; },
    },
  };
  bundle.apply(ctx);
  assert.equal(log.injects.length, 1, 'apply must call ctx.slots.inject exactly once');
  assert.deepEqual(log.injects[0][0], 'settings.section');
  const disposer = log.injects[0][1]();
  assert.equal(log.registers.length, 1, 'injection callback must register exactly one section');
  assert.equal(log.registers[0].name, 'settings.section');
  assert.equal(log.registers[0].id, 'chatgpt-bridge');
  assert.equal(typeof disposer, 'function');
});
