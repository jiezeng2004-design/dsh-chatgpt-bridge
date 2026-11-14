/**
 * Streamable HTTP transport for the MCP server, hosted on the bridge's own
 * node:http server. STATE-FUL mode, one McpServer instance per MCP session
 * (the SDK's Protocol allows exactly one transport per instance). Each
 * session's tools call into the shared Bridge, so per-session server
 * instances are thin and cheap. Loopback-only by default; every request is
 * authenticated against the bearer token when authMode is 'token'.
 *
 * Endpoints (MCP Streamable HTTP):
 *   POST /mcp  JSON-RPC messages (initialize first, then tools/list, tools/call...)
 *   GET  /mcp  SSE stream for server notifications (requires mcp-session-id)
 *   DELETE /mcp  close the MCP session
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BridgeLogger } from './log.js';
import { bridgeHttpUrl, isLoopbackHost, isLoopbackOrigin } from './config.js';

export interface HttpServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024; // 4MB

/** Read and parse a JSON request body (empty bodies yield undefined; malformed JSON rejects with 'invalid-json'). */
function readJsonBody(req: IncomingMessage, maxBytes = MAX_MCP_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Origin handling (MCP spec: servers MUST validate Origin against DNS
 * rebinding). A request carrying an Origin header comes from a browser; only
 * loopback pages may talk to this endpoint. Requests without Origin
 * (server-side tunnel traffic from ChatGPT, CLI clients) are unaffected.
 *
 * Deliberately NOT checked: the Host header. A tunnel may forward the public
 * hostname as Host, so a Host allow-list would break ChatGPT connectivity;
 * the Origin check plus bearer-token auth covers the browser threat model.
 */
function setCors(res: ServerResponse, origin: string | undefined): void {
  res.setHeader('Vary', 'Origin');
  if (origin === undefined) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Last-Event-ID');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function startHttpServer(
  createSessionServer: () => McpServer,
  options: { host: string; port: number; authMode: 'token' | 'none'; authToken: string },
  log: BridgeLogger,
): Promise<HttpServerHandle> {
  if (options.authMode === 'none' && !isLoopbackHost(options.host)) {
    return Promise.reject(
      new Error(`authMode none is only allowed for loopback HTTP listeners; refusing non-loopback host ${options.host}`),
    );
  }
  return new Promise((resolve, reject) => {
    const authorize = (req: IncomingMessage): boolean => {
      if (options.authMode === 'none') return true;
      const header = req.headers.authorization;
      if (header === undefined) return false;
      const match = /^Bearer\s+(.+)$/i.exec(header);
      return match !== null && safeEqual(match[1], options.authToken);
    };

    interface SessionEntry {
      transport: StreamableHTTPServerTransport;
      server: McpServer;
      lastActiveAt: number;
    }
    /** One MCP session: its transport plus the per-session server instance. */
    const sessions = new Map<string, SessionEntry>();
    const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
    const MAX_SESSIONS = 128;

    const dropSession = (id: string, s: SessionEntry): void => {
      sessions.delete(id);
      void s.transport.close().catch(() => {});
      void s.server.close().catch(() => {});
    };

    /** Called before creating a session: drop idle sessions, then evict least-recently-active ones at capacity. */
    const makeRoomForSession = (): void => {
      const now = Date.now();
      for (const [id, s] of [...sessions.entries()]) {
        if (now - s.lastActiveAt > SESSION_IDLE_TIMEOUT_MS) dropSession(id, s);
      }
      while (sessions.size >= MAX_SESSIONS) {
        let oldestId: string | undefined;
        let oldest: SessionEntry | undefined;
        for (const [id, s] of sessions) {
          if (oldest === undefined || s.lastActiveAt < oldest.lastActiveAt) {
            oldestId = id;
            oldest = s;
          }
        }
        if (oldestId === undefined || oldest === undefined) break;
        dropSession(oldestId, oldest);
      }
    };

    const httpServer = createServer(async (req, res) => {
      try {
        const origin = req.headers.origin;
        if (origin !== undefined && !isLoopbackOrigin(origin)) {
          log.warn(`MCP request rejected: forbidden Origin ${JSON.stringify(origin.slice(0, 200))}`);
          res.setHeader('Vary', 'Origin');
          sendJson(res, 403, { error: 'forbidden-origin' });
          return;
        }
        setCors(res, origin);
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        const url = req.url ?? '/';
        const path = url.split('?')[0];
        if (path !== '/mcp') {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
          sendJson(res, 405, { error: 'method-not-allowed' });
          return;
        }
        if (!authorize(req)) {
          log.warn('MCP request rejected: missing or invalid bearer token');
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const sessionId = req.headers['mcp-session-id'];
        const existing = typeof sessionId === 'string' && sessionId !== '' ? sessions.get(sessionId) : undefined;
        if (existing !== undefined) {
          existing.lastActiveAt = Date.now();
          const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
          await existing.transport.handleRequest(req, res, parsedBody);
          return;
        }
        if (sessionId !== undefined || req.method !== 'POST') {
          // Unknown session id, or GET/DELETE without a session: per spec the
          // session must exist before streaming or closing.
          sendJson(res, sessionId !== undefined ? 404 : 400, { error: 'session-not-found' });
          return;
        }
        // Parse the body before allocating a session so bad JSON costs nothing.
        const parsedBody = await readJsonBody(req);
        makeRoomForSession();
        // Fresh MCP session: one transport + one server instance.
        let entry: SessionEntry | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            if (entry !== undefined) sessions.set(id, entry);
          },
        });
        entry = { transport, server: createSessionServer(), lastActiveAt: Date.now() };
        await entry.server.connect(transport);
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id !== undefined) sessions.delete(id);
          void entry?.server.close().catch(() => {});
        };
        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        if (!(error instanceof Error && error.message === 'invalid-json')) {
          log.error(`MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!res.headersSent) {
          if (error instanceof Error && error.message === 'invalid-json') {
            sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
            return;
          }
          const isLarge = error instanceof Error && error.message === 'payload-too-large';
          sendJson(res, isLarge ? 413 : 500, { error: isLarge ? 'payload-too-large' : 'internal-error' });
        } else {
          res.destroy();
        }
      }
    });

    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      const address = httpServer.address() as AddressInfo;
      const port = address.port;
      const url = bridgeHttpUrl(options.host, port);
      log.info(`MCP Streamable HTTP server listening on ${url} (auth: ${options.authMode})`);
      resolve({
        port,
        url,
        close: async () => {
          for (const entry of [...sessions.values()]) {
            try {
              await entry.transport.close();
            } catch {
              // best-effort
            }
            try {
              await entry.server.close();
            } catch {
              // best-effort
            }
          }
          sessions.clear();
          await new Promise<void>((done, fail) => {
            httpServer.close((error) => {
              if (error) fail(error);
              else done();
            });
            httpServer.closeAllConnections();
          });
        },
      });
    });
  });
}
