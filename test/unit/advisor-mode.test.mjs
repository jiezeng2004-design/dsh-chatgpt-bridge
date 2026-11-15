import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema, resolveConfig } from '../../lib/config.js';
import { createMcpServer } from '../../lib/mcp.js';
import { ADVISOR_FORBIDDEN_TOOL_NAMES } from '../../lib/advisor/mcp-tools.js';

const configInput = { authMode: 'none', host: '127.0.0.1' };
const partialConfig = { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 };
const log = { debug() {}, info() {}, warn() {}, error() {} };
const sharedTools = ['dsh_health', 'dsh_list_workspaces'];
const controllerTools = [
  'dsh_health',
  'dsh_list_workspaces',
  'dsh_create_session',
  'dsh_list_sessions',
  'dsh_get_session',
  'dsh_send_message',
  'dsh_get_task_status',
  'dsh_get_result',
  'dsh_cancel_task',
  'dsh_answer_question',
  'dsh_approve',
  'dsh_create_goal',
  'dsh_revise_goal',
  'dsh_pause_goal',
  'dsh_resume_goal',
  'dsh_retry_step',
  'dsh_rerun_step',
  'dsh_wait_until_action_required',
  'dsh_credential_status',
  'dsh_start_goal',
  'dsh_update_goal',
  'dsh_wait_goal',
  'dsh_stop_goal',
];

function registeredNames(cfg) {
  return Object.keys(createMcpServer({}, cfg, log)._registeredTools);
}

test('advisor mode: resolveConfig defaults to controller', () => {
  assert.equal(resolveConfig(configInput, {}).mode, 'controller');
});

test('advisor mode: resolveConfig keeps advisor', () => {
  assert.equal(resolveConfig({ ...configInput, mode: 'advisor' }, {}).mode, 'advisor');
});

test('advisor mode: resolveConfig falls back to controller for all other values', () => {
  for (const mode of ['controller', 'unknown', 'ADVISOR', '', null, undefined, 0, true, {}]) {
    assert.equal(resolveConfig({ ...configInput, mode }, {}).mode, 'controller');
  }
});

test('advisor mode: schemastery defaults mode to controller and accepts advisor', () => {
  assert.equal(ConfigSchema({}).mode, 'controller');
  assert.equal(ConfigSchema({ mode: 'advisor' }).mode, 'advisor');
});

test('advisor mode: partial config without mode preserves all 23 controller tools in order', () => {
  assert.deepEqual(registeredNames(partialConfig), controllerTools);
});

test('advisor mode: explicit controller and unrecognized modes preserve controller tools', () => {
  for (const mode of ['controller', 'unknown', null]) {
    assert.deepEqual(registeredNames({ ...partialConfig, mode }), controllerTools);
  }
});

test('advisor mode: only shared and dsh_advisor_* tools are exposed, never forbidden tools', () => {
  const names = registeredNames({ ...partialConfig, mode: 'advisor' });
  assert.deepEqual(names.slice(0, 2), sharedTools);
  for (const name of names) {
    assert.ok(sharedTools.includes(name) || name.startsWith('dsh_advisor_'), name);
    assert.ok(!ADVISOR_FORBIDDEN_TOOL_NAMES.includes(name), name);
  }
});

test('advisor mode: forbidden list matches every non-shared controller tool', () => {
  const names = registeredNames(partialConfig).filter((name) => !sharedTools.includes(name));
  assert.equal(ADVISOR_FORBIDDEN_TOOL_NAMES.length, 21);
  assert.deepEqual([...ADVISOR_FORBIDDEN_TOOL_NAMES].sort(), names.sort());
});
