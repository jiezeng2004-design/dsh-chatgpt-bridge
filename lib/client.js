window.__ModuleLoader__.load({ id: "dsh-chatgpt-bridge", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// @ts-check
/**
 * dsh-chatgpt-bridge Native Settings section (browser half).
 *
 * Registers a "ChatGPT Bridge" settings.section with the DSH web shell and
 * drives the runtime exclusively through the loopback management API
 * (/_dsh/chatgpt-bridge/*). The UI never infers runtime state from button
 * clicks: every status it shows comes from GET /status. Form fields hydrate
 * from GET /config on open and after Save; the 2s poll must not overwrite
 * in-progress edits (Enable proxy, Tunnel ID, Auto-start). All mutations carry
 * the CSRF guard header and application/json content type.
 *
 * Layout follows the DSH settings recipes used by native pages: group cards
 * (l2 hairline, 16px radius, layer-3 fill), stacked fields for long values,
 * title/control rows for toggles, and custom switches that keep a real
 * checkbox for semantics.
 *
 * Plain-JS build: scripts/build-client.mjs wraps this file into
 * window.__ModuleLoader__.load({ id, factory: (require) => { ... } }).
 * React MUST be acquired from that factory require — the DSH web shell
 * does not expose React as a browser global.
 */
'use strict';

const React = require('react');

// ------------------------------------------------------------------------- types
// Shapes of the loopback management API payloads (src/control/routes.ts and
// src/control/types.ts). The browser only ever sees JSON, so every field the
// server may omit is optional here.

/** @typedef {(key: string) => string} Translate */

/** @typedef {{ ok: false, status?: number, error?: string }} ApiFailure */

/**
 * @template [T=object]
 * @typedef {({ ok: true } & T) | ApiFailure} ApiResult
 */

/**
 * @typedef {object} DetectionResult
 * @property {boolean} installed
 * @property {string} [executablePath]
 * @property {string} [version]
 * @property {string} [error]
 * @property {string} [source]
 */

/**
 * @typedef {object} RuntimeConfigPayload
 * @property {{
 *   executable?: string,
 *   tunnelId?: string,
 *   profileName?: string,
 *   proxy?: { enabled?: boolean, host?: string, port?: number },
 *   autoStart?: boolean,
 * }} [tunnel]
 * @property {{ controlPlaneBaseUrl?: string, runtimeApiKeyRef?: string }} [openai]
 * @property {{ endpoint?: string }} [bridge]
 */

/**
 * Hints from an already-installed tunnel-client (src/control/discover.ts).
 * @typedef {object} DiscoveredPayload
 * @property {{ path?: string }} [executable]
 * @property {string} [tunnelId]
 * @property {string} [controlPlaneBaseUrl]
 * @property {boolean} [runtimeApiKeyAvailable]
 * @property {{ host?: string, port?: number }} [proxy]
 * @property {boolean} [proxyInUse]
 * @property {{ proxyFlag?: boolean }} [runningProcess]
 */

/**
 * Body of GET /config.
 * @typedef {object} ConfigPayload
 * @property {RuntimeConfigPayload} [config]
 * @property {{ runtimeApiKeyConfigured?: boolean }} [secrets]
 * @property {DetectionResult} [detection]
 * @property {DiscoveredPayload} [discovered]
 */

/**
 * Runtime snapshot carried by GET /status.
 * @typedef {object} Snapshot
 * @property {{ status?: string, url?: string, reachable?: boolean }} [bridge]
 * @property {{ status?: string, processRunning?: boolean, healthy?: boolean, ready?: boolean, pid?: number, owned?: boolean }} [tunnel]
 * @property {{ status?: string }} [openai]
 * @property {{ status?: string }} [overall]
 * @property {{ component: string, code: string, message: string }} [lastError]
 * @property {string} [updatedAt]
 */

/** @typedef {{ status: Snapshot }} StatusPayload */

/** @typedef {{ component?: string, lines?: string[] }} LogsPayload */

/** @typedef {{ id: string, ok: boolean, detail?: string, code?: string }} DiagStep */

/** @typedef {{ ok?: boolean, steps?: DiagStep[] }} DiagResult */

/**
 * Settings form values derived from GET /config.
 * @typedef {object} FormFields
 * @property {string} tunnelId
 * @property {string} executable
 * @property {string} controlPlane
 * @property {boolean} autoStart
 * @property {boolean} proxyEnabled
 * @property {string} proxyHost
 * @property {string} proxyPort
 * @property {boolean} keyConfigured
 * @property {DetectionResult | undefined} detection
 * @property {RuntimeConfigPayload} config
 */

/** @typedef {{ target: { value: string } }} InputChangeEvent */

/** @typedef {{ target: { checked: boolean } }} CheckboxChangeEvent */

/**
 * The slice of the DSH plugin context the client uses.
 * @typedef {object} ClientContext
 * @property {(fn: () => unknown, label?: string) => unknown} effect
 * @property {{
 *   register: (ns: string, dictionaries: { zh: Record<string, string>, en: Record<string, string> }) => unknown,
 *   bind: (ns: string) => Translate,
 * }} locale
 * @property {{
 *   inject: (name: string, factory: () => unknown) => unknown,
 *   register: (descriptor: Record<string, unknown>, component: unknown) => unknown,
 * }} slots
 */

const NS = 'chatgptBridge';
const API = '/_dsh/chatgpt-bridge';
const MUTATION_HEADER = 'x-dsh-chatgpt-bridge';
const STYLE_ID = 'dsh-chatgpt-bridge-settings';

const inject = ['slots', 'locale'];

const zh = {
  nav: 'ChatGPT Bridge',
  intro: '配置 OpenAI Tunnel，并管理由插件托管的 tunnel-client。',
  status: '状态',
  overall: '总览',
  bridge: 'Bridge',
  tunnel: 'Tunnel',
  openai: 'OpenAI 控制平面',
  openaiSection: 'OpenAI 接入',
  endpoint: '接入点',
  tunnelClient: 'Tunnel Client',
  notInstalled: '未安装',
  installed: '已安装',
  tunnelId: 'Tunnel ID',
  runtimeKey: 'Runtime API Key',
  configured: '已配置',
  replace: '替换',
  clear: '清除',
  save: '保存',
  start: '启动',
  restart: '重启',
  stop: '停止',
  diagnostics: '运行诊断',
  diagnosticsTitle: '诊断',
  logs: '日志',
  autoStart: '随 DSH 自动启动',
  proxy: '代理',
  enableProxy: '启用代理',
  host: '主机',
  port: '端口',
  controlPlane: 'OpenAI 控制平面地址',
  executable: 'Tunnel 可执行文件路径（可选）',
  configureFirst: '请先填写 Tunnel ID 和 Runtime API Key，然后启动。',
  notConfigured: '未配置',
  unsaved: '有未保存的更改，点击保存后生效。',
  runningExternal: '运行中（外部）',
  externalHint: '检测到已在运行的 tunnel-client。本插件未启动它，也不会停止它。',
  clearKeyConfirm: '确定删除已保存的 Runtime API Key？此操作无法撤销。',
  st_running: '运行中',
  st_stopped: '已停止',
  st_starting: '启动中',
  st_stopping: '停止中',
  st_error: '错误',
  st_unknown: '未知',
  st_ready: '就绪',
  st_degraded: '降级',
  st_offline: '离线',
  st_connected: '已连接',
  st_unauthorized: '未授权',
  st_unreachable: '不可达',
  'st_not-installed': '未安装',
};

const en = {
  nav: 'ChatGPT Bridge',
  intro: 'Configure the OpenAI tunnel and the plugin-owned tunnel-client runtime.',
  status: 'Status',
  overall: 'Overall',
  bridge: 'Bridge',
  tunnel: 'Tunnel',
  openai: 'OpenAI Control Plane',
  openaiSection: 'OpenAI access',
  endpoint: 'Endpoint',
  tunnelClient: 'Tunnel Client',
  notInstalled: 'Not installed',
  installed: 'Installed',
  tunnelId: 'Tunnel ID',
  runtimeKey: 'Runtime API Key',
  configured: 'configured',
  replace: 'Replace',
  clear: 'Clear',
  save: 'Save',
  start: 'Start',
  restart: 'Restart',
  stop: 'Stop',
  diagnostics: 'Run diagnostics',
  diagnosticsTitle: 'Diagnostics',
  logs: 'Logs',
  autoStart: 'Auto start with DSH',
  proxy: 'Proxy',
  enableProxy: 'Enable proxy',
  host: 'Host',
  port: 'Port',
  controlPlane: 'OpenAI control plane base URL',
  executable: 'Executable path (optional)',
  configureFirst: 'Fill in Tunnel ID and Runtime API Key, then Start.',
  notConfigured: 'not configured',
  unsaved: 'Unsaved changes — click Save to persist.',
  runningExternal: 'running (external)',
  externalHint: 'Observed an already-running tunnel-client. This plugin did not start it and will not stop it.',
  clearKeyConfirm: 'Delete the saved Runtime API Key? This cannot be undone.',
  st_running: 'running',
  st_stopped: 'stopped',
  st_starting: 'starting',
  st_stopping: 'stopping',
  st_error: 'error',
  st_unknown: 'unknown',
  st_ready: 'ready',
  st_degraded: 'degraded',
  st_offline: 'offline',
  st_connected: 'connected',
  st_unauthorized: 'unauthorized',
  st_unreachable: 'unreachable',
  'st_not-installed': 'not-installed',
};

const CSS = `
.dcb-page{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;max-width:720px;color:var(--dsw-alias-label-primary);padding-bottom:8px}
.dcb-intro{margin:0;padding:0 2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dcb-banner{margin:0;padding:8px 12px;border-radius:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}
.dcb-banner-warn{color:var(--dsw-alias-state-warn-label,#b45309);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-label,#b45309) 28%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#f59e0b) 10%,transparent)}
.dcb-group{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:16px 18px 18px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle,rgba(128,128,128,.22)));border-radius:16px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,transparent))}
.dcb-group-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 2px 6px;flex-wrap:wrap}
.dcb-group-title{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.dcb-group-extra{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none}
.dcb-status-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dcb-status-chip{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-module-platform,transparent))}
.dcb-status-text{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0;flex:1}
.dcb-status-label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dcb-status-value{min-width:0;font-size:12px;line-height:18px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.dcb-dot{display:inline-block;width:8px;height:8px;border-radius:8px;flex:none}
.dcb-hint{margin:2px 2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dcb-error{margin:2px 2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dcb-meta{display:flex;align-items:baseline;gap:10px;padding:8px 2px 2px;min-width:0}
.dcb-meta-label{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dcb-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:18px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);min-width:0}
.dcb-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:12px;margin-top:4px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.dcb-toolbar-spacer{flex:1;min-width:8px}
.dcb-unsaved{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,#b45309)}
.dcb-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.dcb-row:last-child,.dcb-field:last-child{border-bottom:none}
.dcb-row-label{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);min-width:0}
.dcb-row-control{display:flex;align-items:center;gap:8px;flex:none}
.dcb-field{display:flex;flex-direction:column;gap:6px;padding:10px 2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.dcb-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dcb-field-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dcb-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle,rgba(128,128,128,.35)));background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-input,transparent));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;min-width:0}
.dcb-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary,#9ca3af))}
.dcb-input:focus{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#6366f1));outline:none}
.dcb-input:disabled{opacity:.6;cursor:default}
.dcb-key-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dcb-key-row .dcb-input{flex:1;min-width:160px}
.dcb-split{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:10px}
.dcb-split .dcb-field{border-bottom:none;padding:0}
.dcb-btn{box-sizing:border-box;height:32px;padding:0 14px;border-radius:16px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary)}
.dcb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
.dcb-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-interactive-bg-active,rgba(80,120,255,.9)));color:var(--dsw-alias-label-primary-foreground,#fff)}
.dcb-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,rgba(80,120,255,.95)))}
.dcb-btn-danger{border-color:transparent;color:var(--dsw-alias-state-error-primary,#ef4444);background:transparent}
.dcb-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.1))}
.dcb-btn-sm{height:28px;padding:0 10px;border-radius:14px;font-size:12px}
.dcb-btn:disabled{opacity:.4;cursor:default}
.dcb-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(128,128,128,.35));outline:none}
.dcb-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:11px;font-size:12px;line-height:18px;font-weight:500;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}
.dcb-pill[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);border-color:transparent}
.dcb-pill[data-tone="warn"]{color:var(--dsw-alias-state-warn-label,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#f59e0b) 12%,transparent);border-color:transparent}
.dcb-pill[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);border-color:transparent}
.dcb-switch{position:relative;display:inline-flex;flex:none;cursor:pointer}
.dcb-switch-input{position:absolute;width:1px;height:1px;margin:0;opacity:0}
.dcb-switch-track{display:inline-flex;align-items:center;width:36px;height:20px;padding:2px;box-sizing:border-box;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,transparent);transition:background .15s ease,border-color .15s ease}
.dcb-switch-thumb{display:block;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary,#6b7280);transition:transform .15s ease,background .15s ease}
.dcb-switch:hover .dcb-switch-track{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5))}
.dcb-switch-input:checked + .dcb-switch-track{border-color:var(--dsw-alias-button-primary-fill,#4f46e5);background:var(--dsw-alias-button-primary-fill,#4f46e5)}
.dcb-switch-input:checked + .dcb-switch-track .dcb-switch-thumb{transform:translateX(16px);background:var(--dsw-alias-bg-layer-3,#fff)}
.dcb-switch-input:focus-visible + .dcb-switch-track{outline:2px solid var(--dsw-alias-state-business-primary,#6366f1);outline-offset:2px}
.dcb-steps{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.dcb-step{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:18px}
.dcb-step-flag{flex:none;width:36px;font-weight:600;font-variant-numeric:tabular-nums}
.dcb-step-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dcb-step-fail{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dcb-logs{max-height:220px;overflow:auto;font-size:11px;line-height:16px;margin:4px 0 0;padding:10px 12px;white-space:pre-wrap;border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-module-platform,transparent));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dcb-subhead{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary);padding:8px 2px 0}
@media (max-width:560px){
  .dcb-status-grid{grid-template-columns:1fr}
  .dcb-split{grid-template-columns:1fr}
}
`.replace(/\n/g, '');

function ensureStyles() {
  if (typeof document === 'undefined' || !document.head) return;
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-plugin-css', STYLE_ID);
    document.head.appendChild(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
}

ensureStyles();

/** @param {ClientContext} ctx */
function apply(ctx) {
  ensureStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chatgpt-bridge: copy dictionaries');
  const t = ctx.locale.bind(NS);
  const injected = () => ({ t });
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'chatgpt-bridge',
        order: 66,
        label: () => t('nav'),
        inject: injected,
      },
      BridgeSection,
    ),
  );
}

// ------------------------------------------------------------------------- api

/**
 * @template [T=object]
 * @param {string} path
 * @returns {Promise<ApiResult<T>>}
 */
async function apiGet(path) {
  try {
    const response = await fetch(API + path, { cache: 'no-store' });
    if (!response.ok) return { ok: false, status: response.status };
    return await response.json();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * @template [T=object]
 * @param {'POST' | 'PUT' | 'DELETE'} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<ApiResult<T>>}
 */
async function apiMutate(method, path, body) {
  try {
    const headers = { 'Content-Type': 'application/json', [MUTATION_HEADER]: '1' };
    const response = await fetch(API + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return await response.json();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * Map GET /config onto the settings form. Isolated so the poller can decide
 * whether to apply it: a live 2s config refresh must NEVER overwrite in-progress
 * edits (that is why the Enable-proxy checkbox snapped back the moment it was
 * clicked — an in-flight GET /config completed and reset `proxy.enabled`).
 *
 * @param {ConfigPayload} configJson
 * @returns {FormFields}
 */
function formFromConfigPayload(configJson) {
  const config = configJson.config ?? {};
  const tunnel = config.tunnel ?? {};
  const openai = config.openai ?? {};
  const discovered = configJson.discovered ?? {};
  const detection = configJson.detection;
  const proxy = tunnel.proxy ?? {};
  const claimed = typeof tunnel.tunnelId === 'string' && tunnel.tunnelId !== '';
  const discoveredProxy =
    discovered.proxyInUse === true || discovered.proxy !== undefined || discovered.runningProcess?.proxyFlag === true;
  return {
    tunnelId: tunnel.tunnelId || discovered.tunnelId || '',
    executable: tunnel.executable || detection?.executablePath || discovered.executable?.path || '',
    controlPlane: openai.controlPlaneBaseUrl || discovered.controlPlaneBaseUrl || '',
    autoStart: tunnel.autoStart === true,
    proxyEnabled: proxy.enabled === true || (!claimed && discoveredProxy),
    proxyHost: proxy.host || discovered.proxy?.host || '127.0.0.1',
    proxyPort: proxy.port
      ? String(proxy.port)
      : discovered.proxy?.port
        ? String(discovered.proxy.port)
        : '7892',
    keyConfigured:
      configJson.secrets?.runtimeApiKeyConfigured === true || discovered.runtimeApiKeyAvailable === true,
    detection,
    config,
  };
}

/**
 * Server form values apply only on first load, after Save, or when nothing is dirty.
 * @param {boolean | undefined} dirty
 * @param {boolean | undefined} force
 * @returns {boolean}
 */
function shouldApplyServerForm(dirty, force) {
  return force === true || dirty !== true;
}

/**
 * Missing Runtime API key is not an OpenAI connection failure. Show it as
 * "not configured" instead of a red `error` while the tunnel is down.
 *
 * @param {string} status
 * @param {boolean} keyConfigured
 * @returns {string}
 */
function openaiDisplayStatus(status, keyConfigured) {
  if (!keyConfigured && (status === 'error' || status === 'unknown')) return 'notConfigured';
  return status;
}

/**
 * Translate a runtime status token; falls back to the raw token if missing.
 * @param {Translate} t
 * @param {string | undefined} status
 * @returns {string | undefined}
 */
function tStatus(t, status) {
  if (typeof status !== 'string' || status === '') return status;
  const key = 'st_' + status;
  const value = t(key);
  return value === key ? status : value;
}

/**
 * Replacement field empty → keep the stored value; typed text replaces it.
 * @param {string} stored
 * @param {unknown} draft
 * @returns {string}
 */
function resolveSecretDraft(stored, draft) {
  const typed = typeof draft === 'string' ? draft.trim() : '';
  return typed !== '' ? typed : stored;
}

// ------------------------------------------------------------------------- ui

/** @param {string | undefined} status */
function statusColor(status) {
  if (status === 'ready' || status === 'running' || status === 'connected') return '#22c55e';
  if (status === 'degraded' || status === 'starting' || status === 'stopping') return '#f59e0b';
  if (status === 'error' || status === 'unauthorized' || status === 'unreachable') return '#ef4444';
  return '#9ca3af';
}

/**
 * @param {"primary" | "danger"} [kind]
 * @param {"sm"} [size]
 * @returns {string}
 */
function btnClass(kind, size) {
  return (
    'dcb-btn' +
    (kind === 'primary' ? ' dcb-btn-primary' : kind === 'danger' ? ' dcb-btn-danger' : '') +
    (size === 'sm' ? ' dcb-btn-sm' : '')
  );
}

/** @param {string} color */
function dot(color) {
  return React.createElement('span', { className: 'dcb-dot', style: { background: color } });
}

/** @param {{ label: string, status: string | undefined, display?: string, color?: string }} props */
function StatusLine(props) {
  const display = props.display ?? props.status;
  const color = props.color ?? statusColor(props.status);
  return React.createElement(
    'div',
    { className: 'dcb-status-chip' },
    dot(color),
    React.createElement(
      'div',
      { className: 'dcb-status-text' },
      React.createElement('span', { className: 'dcb-status-label' }, props.label),
      React.createElement('span', { className: 'dcb-status-value' }, display),
    ),
  );
}

/** @param {{ title: string, extra?: unknown, children?: unknown }} props */
function Section(props) {
  return React.createElement(
    'div',
    { className: 'dcb-group' },
    React.createElement(
      'div',
      { className: 'dcb-group-head' },
      React.createElement('div', { className: 'dcb-group-title' }, props.title),
      props.extra ? React.createElement('div', { className: 'dcb-group-extra' }, props.extra) : null,
    ),
    props.children,
  );
}

/** @param {{ label: string, stacked?: boolean, children?: unknown }} props */
function Row(props) {
  const stacked = props.stacked === true;
  if (stacked) {
    return React.createElement(
      'div',
      { className: 'dcb-field' },
      React.createElement('span', { className: 'dcb-field-label' }, props.label),
      props.children,
    );
  }
  return React.createElement(
    'div',
    { className: 'dcb-row' },
    React.createElement('span', { className: 'dcb-row-label' }, props.label),
    React.createElement('div', { className: 'dcb-row-control' }, props.children),
  );
}

/** @param {{ checked: boolean, label: string, onChange: (event: CheckboxChangeEvent) => void }} props */
function Switch(props) {
  return React.createElement(
    'label',
    { className: 'dcb-switch' },
    React.createElement('input', {
      type: 'checkbox',
      className: 'dcb-switch-input',
      checked: props.checked,
      onChange: props.onChange,
      'aria-label': props.label,
    }),
    React.createElement(
      'span',
      { className: 'dcb-switch-track', 'aria-hidden': 'true' },
      React.createElement('span', { className: 'dcb-switch-thumb' }),
    ),
  );
}

/**
 * @param {{
 *   value: string,
 *   onChange: (event: InputChangeEvent) => void,
 *   type?: string,
 *   autoComplete?: string,
 *   spellCheck?: boolean,
 *   placeholder?: string,
 * }} props
 */
function fieldInput(props) {
  return React.createElement('input', { ...props, className: 'dcb-input' });
}

// ------------------------------------------------------------------------- section

/** @param {{ t: Translate }} props */
function BridgeSection(props) {
  const t = props.t;
  const [snapshot, setSnapshot] = React.useState(/** @type {Snapshot | undefined} */ (undefined));
  const [config, setConfig] = React.useState(/** @type {RuntimeConfigPayload | undefined} */ (undefined));
  const [detection, setDetection] = React.useState(/** @type {DetectionResult | undefined} */ (undefined));
  const [keyConfigured, setKeyConfigured] = React.useState(false);
  const [keyInput, setKeyInput] = React.useState('');
  const [tunnelId, setTunnelId] = React.useState('');
  const [tunnelIdInput, setTunnelIdInput] = React.useState('');
  const [executable, setExecutable] = React.useState('');
  const [controlPlane, setControlPlane] = React.useState('');
  const [autoStart, setAutoStart] = React.useState(false);
  const [proxyEnabled, setProxyEnabled] = React.useState(false);
  const [proxyHost, setProxyHost] = React.useState('127.0.0.1');
  const [proxyPort, setProxyPort] = React.useState('7892');
  const [busy, setBusy] = React.useState(/** @type {string | undefined} */ (undefined));
  const [notice, setNotice] = React.useState(/** @type {string | undefined} */ (undefined));
  const [diag, setDiag] = React.useState(/** @type {DiagResult | undefined} */ (undefined));
  const [showLogs, setShowLogs] = React.useState(false);
  const [logs, setLogs] = React.useState(/** @type {string[]} */ ([]));
  const [dirty, setDirty] = React.useState(false);
  const dirtyRef = React.useRef(false);

  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };

  /** @param {FormFields} fields */
  const applyForm = (fields) => {
    setTunnelId(fields.tunnelId);
    setTunnelIdInput('');
    setExecutable(fields.executable);
    setControlPlane(fields.controlPlane);
    setAutoStart(fields.autoStart);
    setProxyEnabled(fields.proxyEnabled);
    setProxyHost(fields.proxyHost);
    setProxyPort(fields.proxyPort);
    setKeyConfigured(fields.keyConfigured);
    if (fields.detection !== undefined) setDetection(fields.detection);
    if (fields.config !== undefined) setConfig(fields.config);
  };

  const refreshStatus = React.useCallback(async () => {
    try {
      /** @type {ApiResult<StatusPayload>} */
      const statusJson = await apiGet('/status');
      if (statusJson.ok) setSnapshot(statusJson.status);
    } catch {
      // transient
    }
  }, []);

  const hydrateConfig = React.useCallback(/** @param {{ force?: boolean }} [opts] */ async (opts) => {
    try {
      /** @type {ApiResult<ConfigPayload>} */
      const configJson = await apiGet('/config');
      if (!configJson.ok) return;
      const fields = formFromConfigPayload(configJson);
      setDetection(fields.detection);
      setKeyConfigured(fields.keyConfigured);
      setConfig(fields.config);
      if (shouldApplyServerForm(dirtyRef.current, opts?.force === true)) {
        applyForm(fields);
        dirtyRef.current = false;
        setDirty(false);
      }
    } catch {
      // transient
    }
  }, []);

  const refresh = React.useCallback(async () => {
    await Promise.all([refreshStatus(), hydrateConfig()]);
  }, [refreshStatus, hydrateConfig]);

  React.useEffect(() => {
    ensureStyles();
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refreshStatus();
      void hydrateConfig();
    }, 2000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshStatus();
        void hydrateConfig();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, refreshStatus, hydrateConfig]);

  /** @param {string} action */
  const runAction = async (action) => {
    setBusy(action);
    setNotice(undefined);
    try {
      const json = await apiMutate('POST', '/' + action);
      if (!json.ok) setNotice(json.error ?? action + ' failed');
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(undefined);
      await refresh();
    }
  };

  const saveConfig = async () => {
    setBusy('save');
    setNotice(undefined);
    const body = {
      tunnel: {
        tunnelId: resolveSecretDraft(tunnelId, tunnelIdInput),
        autoStart,
        proxy: { enabled: proxyEnabled, host: proxyHost, port: Number(proxyPort) || undefined },
        executable: executable.trim(),
      },
      openai: { controlPlaneBaseUrl: controlPlane.trim() },
    };
    try {
      const json = await apiMutate('PUT', '/config', body);
      if (!json.ok) {
        setNotice(json.error ?? 'save failed');
        return;
      }
      dirtyRef.current = false;
      setDirty(false);
      await Promise.all([refreshStatus(), hydrateConfig({ force: true })]);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(undefined);
    }
  };

  const replaceKey = async () => {
    if (keyInput.trim() === '') return;
    setBusy('key');
    setNotice(undefined);
    try {
      const json = await apiMutate('PUT', '/secret/runtime-api-key', { value: keyInput });
      if (!json.ok) setNotice(json.error ?? 'save key failed');
      else setKeyInput('');
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(undefined);
      await refresh();
    }
  };

  const clearKey = async () => {
    if (keyConfigured) {
      const confirmFn = typeof globalThis.confirm === 'function' ? globalThis.confirm : undefined;
      if (confirmFn !== undefined && confirmFn(t('clearKeyConfirm')) !== true) return;
    }
    setBusy('key');
    try {
      await apiMutate('DELETE', '/secret/runtime-api-key');
      setKeyInput('');
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(undefined);
      await refresh();
    }
  };

  const runDiagnostics = async () => {
    setBusy('diag');
    setNotice(undefined);
    try {
      /** @type {ApiResult<DiagResult>} */
      const json = await apiMutate('POST', '/diagnostics');
      setDiag(json);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(undefined);
    }
  };

  const loadLogs = async () => {
    setShowLogs(!showLogs);
    if (showLogs) return;
    try {
      /** @type {ApiResult<LogsPayload>} */
      const json = await apiGet('/logs?component=manager&limit=200');
      if (json.ok) setLogs(json.lines ?? []);
    } catch {
      setLogs([]);
    }
  };

  const tunnelStatus = snapshot?.tunnel?.status ?? 'stopped';
  const overallStatus = snapshot?.overall?.status ?? 'stopped';
  const bridgeStatus = snapshot?.bridge?.status ?? 'offline';
  const openaiStatus = snapshot?.openai?.status ?? 'unknown';
  const openaiShown = openaiDisplayStatus(openaiStatus, keyConfigured);
  const openaiDisplay = openaiShown === 'notConfigured' ? t('notConfigured') : tStatus(t, openaiShown);
  const openaiColor = openaiShown === 'notConfigured' ? '#f59e0b' : statusColor(openaiStatus);
  const tunnelExternal = snapshot?.tunnel?.owned === false && snapshot?.tunnel?.processRunning === true;
  const tunnelDisplay = tunnelExternal ? t('runningExternal') : tStatus(t, tunnelStatus);
  const tunnelColor = tunnelExternal ? statusColor('running') : statusColor(tunnelStatus);
  const runtimeLocked = busy !== undefined || tunnelExternal;
  const endpoint = snapshot?.bridge?.url ?? config?.bridge?.endpoint ?? 'http://127.0.0.1:3456/mcp';
  const tunnelIdConfigured = tunnelId.trim() !== '';

  /** @type {unknown[]} */
  const children = [];

  if (config === undefined && snapshot === undefined) {
    children.push(React.createElement('div', { className: 'dcb-banner' }, t('configureFirst')));
  }
  if (notice !== undefined) {
    children.push(React.createElement('div', { className: 'dcb-banner dcb-banner-warn', role: 'status' }, notice));
  }

  children.push(
    React.createElement(
      Section,
      { title: t('status') },
      React.createElement(
        'div',
        { className: 'dcb-status-grid' },
        React.createElement(StatusLine, { label: t('overall'), status: overallStatus, display: tStatus(t, overallStatus) }),
        React.createElement(StatusLine, { label: t('bridge'), status: bridgeStatus, display: tStatus(t, bridgeStatus) }),
        React.createElement(StatusLine, {
          label: t('tunnel'),
          status: tunnelStatus,
          display: tunnelDisplay,
          color: tunnelColor,
        }),
        React.createElement(StatusLine, {
          label: t('openai'),
          status: openaiStatus,
          display: openaiDisplay,
          color: openaiColor,
        }),
      ),
      snapshot?.lastError
        ? React.createElement(
            'div',
            { className: 'dcb-error' },
            '[' + snapshot.lastError.component + '] ' + snapshot.lastError.code + ': ' + snapshot.lastError.message,
          )
        : null,
      tunnelExternal ? React.createElement('div', { className: 'dcb-hint' }, t('externalHint')) : null,
      React.createElement(
        'div',
        { className: 'dcb-meta' },
        React.createElement('span', { className: 'dcb-meta-label' }, t('endpoint')),
        React.createElement('code', { className: 'dcb-mono' }, endpoint),
      ),
      React.createElement(
        'div',
        { className: 'dcb-toolbar' },
        React.createElement(
          'button',
          { type: 'button', onClick: () => runAction('start'), disabled: runtimeLocked, className: btnClass('primary') },
          t('start'),
        ),
        React.createElement(
          'button',
          { type: 'button', onClick: () => runAction('restart'), disabled: runtimeLocked, className: btnClass() },
          t('restart'),
        ),
        React.createElement(
          'button',
          { type: 'button', onClick: () => runAction('stop'), disabled: runtimeLocked, className: btnClass('danger') },
          t('stop'),
        ),
        React.createElement('span', { className: 'dcb-toolbar-spacer' }),
        React.createElement(
          'button',
          { type: 'button', onClick: saveConfig, disabled: busy !== undefined, className: btnClass(dirty ? 'primary' : undefined) },
          t('save'),
        ),
        dirty ? React.createElement('span', { className: 'dcb-unsaved' }, t('unsaved')) : null,
        busy !== undefined ? React.createElement('span', { className: 'dcb-hint' }, busy + '...') : null,
      ),
    ),
  );

  children.push(
    React.createElement(
      Section,
      { title: t('tunnelClient') },
      React.createElement(
        Row,
        { label: t('installed'), stacked: true },
        detection?.installed
          ? React.createElement(
              'span',
              { className: 'dcb-mono' },
              detection.executablePath ?? '',
              detection.version ? ' (v' + detection.version + ')' : null,
            )
          : React.createElement('span', { className: 'dcb-error' }, t('notInstalled')),
      ),
      React.createElement(
        'div',
        { className: 'dcb-field' },
        React.createElement(
          'div',
          { className: 'dcb-field-head' },
          React.createElement('span', { className: 'dcb-field-label' }, t('tunnelId')),
          React.createElement(
            'span',
            { className: 'dcb-pill', 'data-tone': tunnelIdConfigured ? 'ok' : 'warn' },
            tunnelIdConfigured ? t('configured') : t('notConfigured'),
          ),
        ),
        React.createElement(
          'div',
          { className: 'dcb-key-row' },
          fieldInput({
            type: 'password',
            value: tunnelIdInput,
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => {
              markDirty();
              setTunnelIdInput(event.target.value);
            },
            placeholder: tunnelIdConfigured ? '••••••••••••' : 'tunnel_...',
          }),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => {
                markDirty();
                setTunnelId('');
                setTunnelIdInput('');
              },
              disabled: busy !== undefined || (!tunnelIdConfigured && tunnelIdInput.trim() === ''),
              className: btnClass('danger', 'sm'),
            },
            t('clear'),
          ),
        ),
      ),
      React.createElement(
        Row,
        { label: t('executable'), stacked: true },
        fieldInput({
          value: executable,
          onChange: (event) => {
            markDirty();
            setExecutable(event.target.value);
          },
          placeholder: 'auto',
        }),
      ),
      React.createElement(
        Row,
        { label: t('autoStart') },
        React.createElement(Switch, {
          checked: autoStart,
          label: t('autoStart'),
          onChange: /** @param {CheckboxChangeEvent} event */ (event) => {
            markDirty();
            setAutoStart(event.target.checked);
          },
        }),
      ),
      React.createElement('div', { className: 'dcb-subhead' }, t('proxy')),
      React.createElement(
        Row,
        { label: t('enableProxy') },
        React.createElement(Switch, {
          checked: proxyEnabled,
          label: t('enableProxy'),
          onChange: /** @param {CheckboxChangeEvent} event */ (event) => {
            markDirty();
            setProxyEnabled(event.target.checked);
          },
        }),
      ),
      proxyEnabled
        ? React.createElement(
            'div',
            { className: 'dcb-split' },
            React.createElement(
              Row,
              { label: t('host'), stacked: true },
              fieldInput({
                value: proxyHost,
                onChange: (event) => {
                  markDirty();
                  setProxyHost(event.target.value);
                },
              }),
            ),
            React.createElement(
              Row,
              { label: t('port'), stacked: true },
              fieldInput({
                value: proxyPort,
                onChange: (event) => {
                  markDirty();
                  setProxyPort(event.target.value);
                },
              }),
            ),
          )
        : null,
    ),
  );

  children.push(
    React.createElement(
      Section,
      { title: t('openaiSection') },
      React.createElement(
        'div',
        { className: 'dcb-field' },
        React.createElement(
          'div',
          { className: 'dcb-field-head' },
          React.createElement('span', { className: 'dcb-field-label' }, t('runtimeKey')),
          React.createElement(
            'span',
            { className: 'dcb-pill', 'data-tone': keyConfigured ? 'ok' : 'warn' },
            keyConfigured ? t('configured') : t('notConfigured'),
          ),
        ),
        React.createElement(
          'div',
          { className: 'dcb-key-row' },
          fieldInput({
            type: 'password',
            value: keyInput,
            onChange: (event) => setKeyInput(event.target.value),
            placeholder: keyConfigured ? '••••••••••••' : '',
          }),
          React.createElement(
            'button',
            { type: 'button', onClick: replaceKey, disabled: busy !== undefined, className: btnClass('primary', 'sm') },
            t('replace'),
          ),
          React.createElement(
            'button',
            { type: 'button', onClick: clearKey, disabled: busy !== undefined, className: btnClass('danger', 'sm') },
            t('clear'),
          ),
        ),
      ),
      React.createElement(
        Row,
        { label: t('controlPlane'), stacked: true },
        fieldInput({
          value: controlPlane,
          onChange: (event) => {
            markDirty();
            setControlPlane(event.target.value);
          },
          placeholder: 'https://api.openai.com',
        }),
      ),
    ),
  );

  children.push(
    React.createElement(
      Section,
      {
        title: t('diagnosticsTitle'),
        extra: [
          React.createElement(
            'button',
            { key: 'diag', type: 'button', onClick: runDiagnostics, disabled: busy !== undefined, className: btnClass(undefined, 'sm') },
            t('diagnostics'),
          ),
          React.createElement(
            'button',
            { key: 'logs', type: 'button', onClick: loadLogs, className: btnClass(undefined, 'sm') },
            t('logs'),
          ),
        ],
      },
      diag
        ? React.createElement(
            'div',
            { className: 'dcb-steps' },
            (diag.steps ?? []).map((step) =>
              React.createElement(
                'div',
                { key: step.id, className: 'dcb-step' },
                React.createElement(
                  'span',
                  { className: 'dcb-step-flag ' + (step.ok ? 'dcb-step-ok' : 'dcb-step-fail') },
                  step.ok ? 'PASS' : 'FAIL',
                ),
                React.createElement('span', null, step.id),
                step.detail ? React.createElement('span', { className: 'dcb-hint' }, step.detail) : null,
              ),
            ),
          )
        : null,
      showLogs
        ? React.createElement('pre', { className: 'dcb-logs' }, logs.join('\n') || '(empty)')
        : null,
    ),
  );

  return React.createElement('div', { className: 'dcb-page' }, React.createElement('p', { className: 'dcb-intro' }, t('intro')), ...children);
}

// The UI components are also exported for the render smoke test (the DSH
// module loader consumes only `apply`/`inject`; the extra exports are inert
// to the shell but let the test render the section against a minimal React).
module.exports = {
  apply,
  inject,
  Section,
  Row,
  StatusLine,
  BridgeSection,
  formFromConfigPayload,
  shouldApplyServerForm,
  openaiDisplayStatus,
  resolveSecretDraft,
  tStatus,
  dictionaries: { zh, en },
};

return module.exports; } });
