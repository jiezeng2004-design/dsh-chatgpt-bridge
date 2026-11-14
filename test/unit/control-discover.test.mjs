import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import {
  discoverExecutable,
  discoverExistingRuntime,
  wellKnownExecutableCandidates,
  parseTunnelCommandLine,
  healthBaseFromListenAddr,
} from '../../lib/control/discover.js';

const WIN_EXE = 'D:\\Application\\tunnel-client\\tunnel-client.exe';

test('discover: configured path wins when it exists', () => {
  const found = discoverExecutable({
    configuredExecutable: 'C:\\custom\\tunnel-client.exe',
    platform: 'win32',
    env: { PATH: '' },
    existsSync: (p) => p === 'C:\\custom\\tunnel-client.exe',
    listRunningExecutables: () => [WIN_EXE],
  });
  assert.deepEqual(found, { path: 'C:\\custom\\tunnel-client.exe', source: 'configured' });
});

test('discover: missing configured path does not fall through (user override)', () => {
  const found = discoverExecutable({
    configuredExecutable: 'C:\\missing\\tunnel-client.exe',
    platform: 'win32',
    env: { PATH: 'D:\\Application\\tunnel-client', USERPROFILE: 'C:\\Users\\x' },
    existsSync: (p) => p === WIN_EXE,
    listRunningExecutables: () => [WIN_EXE],
  });
  assert.equal(found, undefined);
});

test('discover: PATH is used when nothing is configured', () => {
  const dir = 'C:\\tools';
  const candidate = pathWin32.join(dir, 'tunnel-client.exe');
  const found = discoverExecutable({
    platform: 'win32',
    env: { PATH: dir },
    existsSync: (p) => p === candidate,
    wellKnownPaths: [WIN_EXE],
    listRunningExecutables: () => [WIN_EXE],
  });
  assert.deepEqual(found, { path: candidate, source: 'path' });
});

test('discover: well-known Application\\tunnel-client is found without PATH', () => {
  const found = discoverExecutable({
    platform: 'win32',
    env: { PATH: '', USERPROFILE: 'C:\\Users\\x', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
    existsSync: (p) => p === WIN_EXE,
    listRunningExecutables: () => [],
  });
  assert.deepEqual(found, { path: WIN_EXE, source: 'well-known' });
});

test('discover: running process image is a last-resort hint', () => {
  const found = discoverExecutable({
    platform: 'win32',
    env: { PATH: '' },
    existsSync: (p) => p === WIN_EXE,
    wellKnownPaths: ['C:\\nope\\tunnel-client.exe'],
    listRunningExecutables: () => [WIN_EXE],
  });
  assert.deepEqual(found, { path: WIN_EXE, source: 'running-process' });
});

test('discover: nothing installed returns undefined', () => {
  const found = discoverExecutable({
    platform: 'win32',
    env: { PATH: '' },
    existsSync: () => false,
    wellKnownPaths: [WIN_EXE],
    listRunningExecutables: () => [WIN_EXE],
  });
  assert.equal(found, undefined);
});

test('discover: well-known Windows list includes D:\\Application\\tunnel-client', () => {
  const candidates = wellKnownExecutableCandidates({ USERPROFILE: 'C:\\Users\\x' }, 'win32');
  assert.ok(candidates.includes(WIN_EXE));
  assert.ok(
    candidates.every((c) => c.includes('\\') && !c.includes('/')),
    'win32 well-known paths must use Windows separators on any host OS',
  );
});

test('discover: well-known POSIX list uses posix separators even on Windows host', () => {
  const candidates = wellKnownExecutableCandidates({ HOME: '/home/x' }, 'linux');
  assert.ok(candidates.includes('/usr/local/bin/tunnel-client'));
  assert.ok(candidates.includes(pathPosix.join('/home/x', '.local', 'bin', 'tunnel-client')));
  assert.ok(
    candidates.every((c) => !c.includes('\\')),
    'linux well-known paths must use posix separators on any host OS',
  );
});

test('discover: official profile supplies tunnel id and control plane, never the key', () => {
  const profileDir = 'C:\\Users\\x\\AppData\\Roaming\\tunnel-client';
  const profilePath = pathWin32.join(profileDir, 'dsh-chatgpt-bridge.yaml');
  const yaml = [
    'config_version: 1',
    'control_plane:',
    '  base_url: "https://api.openai.com"',
    '  tunnel_id: "tunnel_test_discovery_fixture"',
    '  api_key: "sk-DO-NOT-RETURN-THIS-VALUE"',
    'health:',
    '  listen_addr: "127.0.0.1:8080"',
    'mcp:',
    '  server_urls:',
    '    - url: "http://127.0.0.1:3456/mcp"',
    '',
  ].join('\n');
  const files = { [profilePath]: yaml };
  const result = discoverExistingRuntime({
    platform: 'win32',
    env: { PATH: '', APPDATA: 'C:\\Users\\x\\AppData\\Roaming', HTTP_PROXY: 'http://127.0.0.1:7892' },
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw new Error('missing ' + p);
      return files[p];
    },
    readdirSync: (dir) => (dir === profileDir ? ['dsh-chatgpt-bridge.yaml'] : []),
    profileDirs: [profileDir],
    wellKnownPaths: [],
    listRunningExecutables: () => [],
  });
  assert.equal(result.tunnelId, 'tunnel_test_discovery_fixture');
  assert.equal(result.controlPlaneBaseUrl, 'https://api.openai.com');
  assert.equal(result.profileName, 'dsh-chatgpt-bridge');
  assert.equal(result.runtimeApiKeyAvailable, true, 'literal api_key is reported as presence only');
  assert.equal(result.healthBaseUrl, 'http://127.0.0.1:8080');
  assert.deepEqual(result.proxy, { host: '127.0.0.1', port: 7892, source: 'env' });
  assert.ok(!JSON.stringify(result).includes('sk-DO-NOT-RETURN'));
});

test('discover: running process is observed with pid and proxy flag, never the command line', () => {
  const result = discoverExistingRuntime({
    platform: 'win32',
    env: { PATH: '', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('no profile');
    },
    readdirSync: () => [],
    profileDirs: ['C:\\Users\\x\\AppData\\Roaming\\tunnel-client'],
    wellKnownPaths: [],
    listRunningExecutables: () => [],
    listRunningProcesses: () => [
      {
        pid: 16984,
        executablePath: WIN_EXE,
        profileName: 'dsh-chatgpt-bridge',
        proxyFlag: true,
      },
    ],
  });
  assert.deepEqual(result.runningProcess, {
    pid: 16984,
    executablePath: WIN_EXE,
    profileName: 'dsh-chatgpt-bridge',
    proxyFlag: true,
  });
  assert.equal(result.proxyInUse, true);
  assert.ok(!JSON.stringify(result).includes('Authorization'));
});

test('discover: parseTunnelCommandLine extracts profile and proxy flag', () => {
  const parsed = parseTunnelCommandLine(
    '"D:\\tools\\tunnel-client\\tunnel-client.exe" run --profile dsh-chatgpt-bridge --control-plane.http-proxy env:TUNNEL_CONTROL_PROXY --mcp.extra-headers "Authorization: env:DSH_BRIDGE_AUTH"',
  );
  assert.equal(parsed.profileName, 'dsh-chatgpt-bridge');
  assert.equal(parsed.proxyFlag, true);
  assert.equal(healthBaseFromListenAddr('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(healthBaseFromListenAddr('http://[::1]:8080'), 'http://[::1]:8080');
  assert.equal(healthBaseFromListenAddr('127.0.0.1:0'), undefined);
  assert.equal(healthBaseFromListenAddr('0.0.0.0:8080'), undefined);
});

test('discover: env: API key is reported only as a boolean', () => {
  const profileDir = '/tmp/profiles';
  const profilePath = pathPosix.join(profileDir, 'dsh-chatgpt-bridge.yaml');
  const yaml = 'control_plane:\n  tunnel_id: tunnel_abc\n  api_key: "env:CONTROL_PLANE_API_KEY"\n';
  const result = discoverExistingRuntime({
    platform: 'linux',
    env: { HOME: '/tmp', CONTROL_PLANE_API_KEY: 'sk-present-but-must-not-leak' },
    existsSync: (p) => p === profilePath,
    readFileSync: () => yaml,
    readdirSync: () => ['dsh-chatgpt-bridge.yaml'],
    profileDirs: [profileDir],
    wellKnownPaths: [],
    listRunningExecutables: () => [],
  });
  assert.equal(result.tunnelId, 'tunnel_abc');
  assert.equal(result.runtimeApiKeyAvailable, true);
  assert.ok(!JSON.stringify(result).includes('sk-present-but-must-not-leak'));
});

test('discover: file: API key is available only when the file exists', () => {
  const profileDir = '/tmp/profiles';
  const profilePath = pathPosix.join(profileDir, 'other.yaml');
  const keyFile = '/tmp/secrets/runtime-api-key';
  const yaml = 'tunnel_id: tunnel_file\napi_key: "file:/tmp/secrets/runtime-api-key"\n';
  const result = discoverExistingRuntime({
    platform: 'linux',
    env: { HOME: '/tmp' },
    existsSync: (p) => p === profilePath || p === keyFile,
    readFileSync: () => yaml,
    readdirSync: () => ['other.yaml'],
    profileDirs: [profileDir],
    wellKnownPaths: [],
    listRunningExecutables: () => [],
  });
  assert.equal(result.runtimeApiKeyAvailable, true);
  assert.equal(result.tunnelId, 'tunnel_file');
});
