import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSocketHostname } from '../config.js';
import { redactText } from '../redact.js';
export const ROUTE_BASE = '/_dsh/chatgpt-bridge';
export const MUTATION_HEADER = 'x-dsh-chatgpt-bridge';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LIMIT = 1000;
function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}
function isLoopbackRemote(req) {
    const address = req.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function hostAllowed(host) {
    if (host === undefined || host === '')
        return false;
    const normalized = host.toLowerCase().replace(/\[([^\]]+)\]/g, '$1').replace(/:\d+$/, '');
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}
function originAllowed(origin) {
    if (origin === undefined || origin === '')
        return false;
    try {
        const host = normalizeSocketHostname(new URL(origin).hostname).toLowerCase();
        return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    }
    catch {
        return false;
    }
}
function isMutation(method) {
    return method === 'POST' || method === 'PUT' || method === 'DELETE';
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body-too-large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function sanitizeConfig(raw) {
    const out = {};
    if (typeof raw !== 'object' || raw === null)
        throw new Error('invalid-config');
    const body = raw;
    const tunnel = body.tunnel;
    if (tunnel !== undefined && typeof tunnel === 'object') {
        const t = {};
        if (typeof tunnel.executable === 'string') {
            const sanitized = sanitizePath(tunnel.executable).trim();
            t.executable = sanitized === '' ? undefined : sanitized;
        }
        else if (tunnel.executable === null) {
            t.executable = undefined;
        }
        // The settings form sends an empty ID before setup and when clearing it.
        // Preserve that explicit unconfigured state; validate every nonempty ID.
        if (typeof tunnel.tunnelId === 'string')
            t.tunnelId = tunnel.tunnelId === '' ? '' : sanitizeIdentifier(tunnel.tunnelId, 256);
        if (typeof tunnel.profileName === 'string')
            t.profileName = sanitizeIdentifier(tunnel.profileName, 128);
        if (typeof tunnel.autoStart === 'boolean')
            t.autoStart = tunnel.autoStart;
        const proxy = tunnel.proxy;
        if (proxy !== undefined && typeof proxy === 'object') {
            const p = { enabled: false };
            if (typeof proxy.enabled === 'boolean')
                p.enabled = proxy.enabled;
            if (typeof proxy.host === 'string')
                p.host = sanitizeNoWhitespace(proxy.host, 255);
            if (typeof proxy.port === 'number') {
                if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535)
                    throw new Error('invalid-proxy-port');
                p.port = proxy.port;
            }
            t.proxy = p;
        }
        out.tunnel = t;
    }
    const openai = body.openai;
    if (openai !== undefined && typeof openai === 'object') {
        const o = {};
        if (typeof openai.controlPlaneBaseUrl === 'string') {
            const trimmed = openai.controlPlaneBaseUrl.trim();
            o.controlPlaneBaseUrl = trimmed === '' ? undefined : sanitizeUrl(trimmed);
        }
        else if (openai.controlPlaneBaseUrl === null) {
            o.controlPlaneBaseUrl = undefined;
        }
        // runtimeApiKeyRef is never accepted through PUT /config (secrets only via
        // the dedicated secret endpoint).
        out.openai = o;
    }
    const bridge = body.bridge;
    if (bridge !== undefined && typeof bridge === 'object') {
        const b = {};
        if (typeof bridge.endpoint === 'string')
            b.endpoint = sanitizeLoopbackUrl(bridge.endpoint);
        out.bridge = b;
    }
    return out;
}
function sanitizePath(value) {
    if (/[\x00-\x1f]/.test(value))
        throw new Error('invalid-executable');
    return value.slice(0, 1024);
}
function sanitizeIdentifier(value, max) {
    if (!/^[A-Za-z0-9._-]+$/.test(value))
        throw new Error('invalid-identifier');
    return value.slice(0, max);
}
function sanitizeNoWhitespace(value, max) {
    if (/[\s\x00-\x1f]/.test(value))
        throw new Error('invalid-value');
    return value.slice(0, max);
}
function sanitizeUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('invalid-url');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error('invalid-url');
    return url.toString();
}
function sanitizeLoopbackUrl(value) {
    const url = sanitizeUrl(value);
    const parsed = new URL(url);
    const host = normalizeSocketHostname(parsed.hostname).toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')
        throw new Error('endpoint-must-be-loopback');
    return url;
}
function tailFile(path, limit) {
    try {
        if (!existsSync(path))
            return [];
        const stat = statSync(path);
        if (stat.size === 0)
            return [];
        const CHUNK_SIZE = 128 * 1024;
        let raw;
        if (stat.size <= CHUNK_SIZE) {
            raw = readFileSync(path, 'utf8');
        }
        else {
            const fd = openSync(path, 'r');
            try {
                const buffer = Buffer.alloc(CHUNK_SIZE);
                const position = stat.size - CHUNK_SIZE;
                readSync(fd, buffer, 0, CHUNK_SIZE, position);
                raw = buffer.toString('utf8');
            }
            finally {
                closeSync(fd);
            }
        }
        const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
        return lines.slice(-limit).map((line) => redactText(line));
    }
    catch {
        return [];
    }
}
export function createManagementApi(manager, options) {
    const disposers = [];
    const guard = (req, res, requireOrigin) => {
        if (!isLoopbackRemote(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' });
            return false;
        }
        if (!hostAllowed(req.headers.host)) {
            sendJson(res, 403, { ok: false, error: 'bad-host' });
            return false;
        }
        if (requireOrigin && !originAllowed(req.headers.origin)) {
            sendJson(res, 403, { ok: false, error: 'bad-origin' });
            return false;
        }
        return true;
    };
    const guardMutation = (req, res) => {
        if (!guard(req, res, true))
            return false;
        if (req.headers[MUTATION_HEADER] !== '1') {
            sendJson(res, 403, { ok: false, error: 'bad-header' });
            return false;
        }
        const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
            sendJson(res, 415, { ok: false, error: 'content-type-must-be-json' });
            return false;
        }
        return true;
    };
    const handle = async (req, res) => {
        try {
            await handleInner(req, res);
        }
        catch (error) {
            if (res.headersSent)
                return;
            sendJson(res, 500, {
                ok: false,
                error: 'internal-error',
                message: redactText(error instanceof Error ? error.message : String(error)),
            });
        }
    };
    const handleInner = async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const base = ROUTE_BASE;
        // GET endpoints (read-only, no mutation).
        if (path === base + '/status' && method === 'GET') {
            if (!guard(req, res, false))
                return;
            await manager.refresh();
            sendJson(res, 200, { ok: true, status: manager.getSnapshot() });
            return;
        }
        if (path === base + '/config' && method === 'GET') {
            if (!guard(req, res, false))
                return;
            const config = manager.getConfig();
            const detection = await manager.getDetection();
            sendJson(res, 200, {
                ok: true,
                config,
                secrets: { runtimeApiKeyConfigured: manager.secretStore.runtimeApiKeyConfigured() },
                detection,
                discovered: manager.getDiscovery(),
            });
            return;
        }
        if (path === base + '/logs' && method === 'GET') {
            if (!guard(req, res, false))
                return;
            const component = url.searchParams.get('component') ?? 'manager';
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200) || 200, 1), MAX_LOG_LIMIT);
            const file = component === 'tunnel' ? 'tunnel-client.ndjson' : 'manager.ndjson';
            const lines = tailFile(join(options.dshHome, 'chatgpt-bridge', 'logs', file), limit);
            sendJson(res, 200, { ok: true, component, lines });
            return;
        }
        // Mutations.
        if (path === base + '/config' && method === 'PUT') {
            if (!guardMutation(req, res))
                return;
            let parsed;
            try {
                parsed = JSON.parse(await readBody(req));
            }
            catch {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
            }
            try {
                const patch = sanitizeConfig(parsed);
                const saved = await manager.saveConfig(patch);
                sendJson(res, 200, { ok: true, config: saved });
            }
            catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid-config' });
            }
            return;
        }
        if (path === base + '/secret/runtime-api-key' && method === 'PUT') {
            if (!guardMutation(req, res))
                return;
            let parsed;
            try {
                parsed = JSON.parse(await readBody(req));
            }
            catch {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
            }
            const value = parsed?.value;
            if (typeof value !== 'string' || value.trim() === '') {
                sendJson(res, 400, { ok: false, error: 'runtime-api-key-empty' });
                return;
            }
            const ref = manager.secretStore.writeRuntimeApiKey(value);
            await manager.saveConfig({ openai: { runtimeApiKeyRef: ref } });
            sendJson(res, 200, { ok: true, configured: true });
            return;
        }
        if (path === base + '/secret/runtime-api-key' && method === 'DELETE') {
            if (!guardMutation(req, res))
                return;
            manager.secretStore.clearRuntimeApiKey();
            await manager.saveConfig({ openai: { runtimeApiKeyRef: undefined } });
            sendJson(res, 200, { ok: true, configured: false });
            return;
        }
        if (path === base + '/start' && method === 'POST') {
            if (!guardMutation(req, res))
                return;
            await readBody(req).catch(() => '');
            const status = await manager.start();
            sendJson(res, 200, { ok: true, status });
            return;
        }
        if (path === base + '/stop' && method === 'POST') {
            if (!guardMutation(req, res))
                return;
            await readBody(req).catch(() => '');
            const status = await manager.stop();
            sendJson(res, 200, { ok: true, status });
            return;
        }
        if (path === base + '/restart' && method === 'POST') {
            if (!guardMutation(req, res))
                return;
            await readBody(req).catch(() => '');
            const status = await manager.restart();
            sendJson(res, 200, { ok: true, status });
            return;
        }
        if (path === base + '/diagnostics' && method === 'POST') {
            if (!guardMutation(req, res))
                return;
            await readBody(req).catch(() => '');
            const result = await manager.diagnostics();
            sendJson(res, 200, result);
            return;
        }
        sendJson(res, 404, { ok: false, error: 'not-found' });
    };
    return {
        register(webServer) {
            disposers.push(webServer.register({ kind: 'prefix', path: ROUTE_BASE, handler: handle }));
            return () => {
                for (const dispose of disposers.splice(0))
                    dispose();
            };
        },
    };
}
