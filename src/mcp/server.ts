/**
 * MCP server entry point for korinfra.
 *
 * Supports two transports:
 *   - stdio (default) — reads JSON-RPC from stdin, writes to stdout. Used by Claude Code and Cursor.
 *   - http            — Streamable HTTP on a configurable port for other MCP clients.
 *
 * The server runs headless (no TUI). All business logic is delegated to core engine
 * functions via the tool/resource/prompt handlers registered below.
 */

import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { getVersionInfo } from '../utils/version.js';
import { DEFAULT_MCP_PORT } from '../config/types.js';
import { schedulePeriodicFlush } from '../aws/rate-limiter.js';
import { logger } from '../utils/logger.js';
import { redact } from '../redaction/redactor.js';
import { loadConfig } from '../config/index.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import {
  getTokenFilePath,
  getTokenFileMtimeMs,
  readPersistedTokenData,
  persistTokenData,
  revokeToken,
  checkTokenFilePermissions,
} from './token.js';

export interface McpServerOptions {
  transport: 'stdio' | 'http';
  port?: number;
  rotateToken?: boolean;
}

const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

export type BodySizeSource = 'env' | 'config' | 'default';

/** Precedence: KORINFRA_MCP_MAX_BODY_SIZE env > config > default. */
export function getMaxBodySize(configValue?: number): { value: number; source: BodySizeSource } {
  const raw = process.env['KORINFRA_MCP_MAX_BODY_SIZE'];
  if (raw !== undefined && raw !== '') {
    const trimmed = raw.trim();
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed > 0 && String(parsed) === trimmed) {
      return { value: parsed, source: 'env' };
    }
    const fallback = configValue ?? DEFAULT_MAX_BODY_SIZE;
    process.stderr.write(
      `[korinfra] WARNING: KORINFRA_MCP_MAX_BODY_SIZE invalid (${raw}); using ${fallback} bytes.\n`,
    );
  }
  if (configValue !== undefined) return { value: configValue, source: 'config' };
  return { value: DEFAULT_MAX_BODY_SIZE, source: 'default' };
}

/**
 * Creates and returns an initialised (but not yet connected) MCP Server instance
 * with all tools, resources, and prompts registered.
 */
function buildServer(): Server {
  const { name, version, description } = getVersionInfo();

  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: description,
    },
  );

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}

/**
 * Starts the MCP server using the requested transport.
 * Blocks (via keepalive) until the process receives SIGINT/SIGTERM or stdin closes.
 */
export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const { transport, port = DEFAULT_MCP_PORT, rotateToken = false } = options;

  // Load config to get MCP settings
  let mcpConfig: { session_cost_limit: number; max_sessions: number; http_rate_limit: number; session_idle_timeout_ms: number; max_body_size: number };
  try {
    const cfg = await loadConfig();
    mcpConfig = cfg.mcp;
  } catch {
    // Use defaults if config load fails
    mcpConfig = { session_cost_limit: 1000, max_sessions: 100, http_rate_limit: 300, session_idle_timeout_ms: 1_800_000, max_body_size: 10 * 1024 * 1024 };
  }

  if (transport === 'stdio') {
    await startStdio();
  } else {
    await startHttp(port, mcpConfig, rotateToken);
  }
}

// ── Stdio ─────────────────────────────────────────────────────────────────────

async function startStdio(): Promise<void> {
  schedulePeriodicFlush((records) => {
    logger.debug({ count: records.length }, '[mcp] Flushed API call log');
  });
  process.stderr.write('[korinfra] MCP stdio transport active\n');
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive — it exits when stdin closes (client disconnects).
}

// ── IP normalization ──────────────────────────────────────────────────────────

function expandIPv6(ip: string): string {
  const sides = ip.split('::');
  if (sides.length > 2) return ip;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const fill = Array<string>(8 - left.length - right.length).fill('0000');
  return [...left, ...fill, ...right].map(g => g.padStart(4, '0')).join(':');
}

const IPV6_LOOPBACK_EXPANDED = '0000:0000:0000:0000:0000:0000:0000:0001';

function normalizeClientIp(rawIp: string): string {
  let ip = rawIp;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv6(ip) && expandIPv6(ip) === IPV6_LOOPBACK_EXPANDED) {
    return '127.0.0.1';
  }
  return ip;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000; // 1 minute

function checkRateLimit(ip: string, rateLimit: number): boolean {
  const now = Date.now();
  // Hard cap: prevent unbounded memory growth from large numbers of distinct IPs
  if (rateLimitMap.size > 10_000) {
    let deleted = 0;
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetAt) { rateLimitMap.delete(key); if (++deleted >= 500) break; }
    }
    // Hard cap: if still over limit after cleanup, reject this request
    if (rateLimitMap.size > 10_000) return false;
  }
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    // Cap at 5000 entries: delete oldest entry (Map insertion order)
    if (rateLimitMap.size > 5_000) {
      const oldest = rateLimitMap.keys().next().value;
      if (oldest !== undefined) rateLimitMap.delete(oldest);
    }
    return true; // allowed
  }
  if (entry.count >= rateLimit) return false; // denied
  entry.count++;
  return true; // allowed
}

// ── HTTP (Streamable HTTP) ────────────────────────────────────────────────────

async function startHttp(port: number, mcpConfig: { session_cost_limit: number; max_sessions: number; http_rate_limit: number; session_idle_timeout_ms: number; max_body_size: number }, rotateToken: boolean = false): Promise<void> {
  schedulePeriodicFlush((records) => {
    logger.debug({ count: records.length }, '[mcp] Flushed API call log');
  });

  // Rate-limit cleanup interval — only runs when HTTP transport is active
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  }, RATE_WINDOW_MS).unref(); // .unref() so it doesn't prevent process exit

  // Tool call cost weights — prevent cheap calls from exhausting the budget
  const TOOL_CALL_WEIGHTS: Record<string, number> = {
    'collect_aws_resources': 10,
    'get_recommendations': 5,
    // All other tools default to weight 1
  };

  // One transport + server per session (stateful mode).
  const sessions = new Map<
    string,
    {
      server: Server;
      transport: StreamableHTTPServerTransport;
      lastActivityAt: number;
      toolCallCost: number; // Accumulated cost instead of call count
      closing: boolean;     // Set on DELETE to block new tool calls while transport drains
    }
  >();

  const SESSION_IDLE_TIMEOUT_MS = mcpConfig.session_idle_timeout_ms;
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
        void s.transport.close();
        sessions.delete(id);
      }
    }
  }, 5 * 60_000).unref();

  const requireToken = process.env['MCP_HTTP_REQUIRE_TOKEN'] === '1';
  let authToken = process.env['MCP_AUTH_TOKEN'] ?? '';
  if (authToken && authToken.length < 32) {
    process.stderr.write('[korinfra] WARNING: MCP_AUTH_TOKEN is too short (min 32 chars). Ignoring and generating a new token.\n');
    authToken = '';
  }

  // Live re-read is gated on this flag — disabled when MCP_AUTH_TOKEN is set.
  let usingPersistedToken = false;
  let tokenMtimeMs = 0;

  if (!authToken) {
    if (requireToken) {
      process.stderr.write('[korinfra] FATAL: MCP_AUTH_TOKEN must be set when MCP_HTTP_REQUIRE_TOKEN=1. Use a secret manager to inject a secure token (≥32 chars).\n');
      process.exit(1);
    }

    const tokenPath = getTokenFilePath();
    usingPersistedToken = true;

    if (rotateToken) {
      try {
        const rotated = revokeToken();
        authToken = rotated.token;
        process.stderr.write(`[korinfra] MCP auth token rotated (persisted to ${tokenPath}, v${rotated.version})\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[korinfra] FATAL: --rotate-token failed: ${msg}\n`);
        process.exit(1);
      }
    } else {
      const loaded = readPersistedTokenData();
      if (loaded) {
        authToken = loaded.token;
        process.stderr.write(`[korinfra] MCP auth token loaded from ${tokenPath} (v${loaded.version})\n`);
      } else {
        authToken = randomBytes(32).toString('hex');
        try {
          persistTokenData(authToken, 1);
          process.stderr.write(`[korinfra] MCP auth token generated (persisted to ${tokenPath}, v1)\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[korinfra] WARNING: MCP auth token generated but NOT persisted (${msg}). Token will be lost on restart.\n`);
        }
      }
    }
    tokenMtimeMs = getTokenFileMtimeMs();
    checkTokenFilePermissions();
  } else {
    process.stderr.write('[korinfra] MCP auth token from MCP_AUTH_TOKEN env (version tracking and live rotation disabled)\n');
  }

  const { value: maxBodySize, source: maxBodySizeSource } = getMaxBodySize(mcpConfig.max_body_size);
  if (maxBodySize !== DEFAULT_MAX_BODY_SIZE) {
    const sourceLabel = maxBodySizeSource === 'env' ? 'KORINFRA_MCP_MAX_BODY_SIZE' : 'mcp.max_body_size config';
    process.stderr.write(`[korinfra] MCP HTTP max body size: ${maxBodySize} bytes (${sourceLabel})\n`);
  }

  function maybeReloadTokenFromDisk(): void {
    if (!usingPersistedToken) return;
    const statMtime = getTokenFileMtimeMs();
    // Reload on any mtime change (not just newer) — handles restore-from-backup
    // where the replacement file may carry an older mtime than the cached one.
    if (statMtime === 0 || statMtime === tokenMtimeMs) return;
    const reloaded = readPersistedTokenData();
    if (reloaded && reloaded.token !== authToken) {
      authToken = reloaded.token;
      logger.debug({ version: reloaded.version }, '[mcp] Reloaded rotated auth token');
    }
    // Bump even on read failure so we don't retry on every request.
    tokenMtimeMs = statMtime;
  }

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      // Check remoteAddress is defined
      const rawIp = req.socket.remoteAddress;
      if (!rawIp) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cannot determine client address' }));
        return;
      }

      // Reject forwarded IP headers — server binds to localhost only;
      // X-Forwarded-For has no trusted meaning here and could spoof rate-limit keys.
      if (req.headers['x-forwarded-for']) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forwarded IP headers are not accepted' }));
        return;
      }

      // Rate limiting — checked before any other processing
      // Normalize IP to a canonical form for rate-limit key consistency.
      // IPv4-mapped IPv6 (::ffff:x.x.x.x) is stripped to its IPv4 form.
      // All IPv6 loopback representations are collapsed to 127.0.0.1.
      const clientIp = normalizeClientIp(rawIp);
      if (!checkRateLimit(clientIp, mcpConfig.http_rate_limit)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
      }

      // Reject cross-origin browser requests — MCP HTTP is not a browser API
      const origin = req.headers['origin'];
      if (origin) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'null',
        });
        res.end(JSON.stringify({ error: 'Cross-origin requests are not allowed' }));
        return;
      }

      maybeReloadTokenFromDisk();

      // Bearer token auth — hash both sides before comparing to prevent timing side-channel.
      const authHeader = req.headers['authorization'] ?? '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const providedBuf = Buffer.from(provided, 'utf8');
      const tokenBuf = Buffer.from(authToken, 'utf8');

      function hashToken(buf: Buffer): Buffer {
        return createHash('sha256').update(buf).digest();
      }

      // Always hash both regardless of input length — SHA256 always yields 32 bytes,
      // so timingSafeEqual never throws and timing is constant.
      const providedHash = hashToken(providedBuf);
      const expectedHash = hashToken(tokenBuf);
      const isValidToken = timingSafeEqual(providedHash, expectedHash);
      if (!isValidToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (req.method === 'DELETE') {
        // Session cleanup
        const sessionId = req.headers['mcp-session-id'];
        if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid session ID format' }));
          return;
        }
        const session = sessions.get(sessionId);
        if (session) {
          session.closing = true;
          sessions.delete(sessionId);
          await session.transport.close();
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== 'POST' && req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET, POST, DELETE' });
        res.end('Method Not Allowed');
        return;
      }

      // Collect request body for POST
      let body: string | null;
      try {
        body = await readBody(req, maxBodySize);
      } catch (err) {
        if (err instanceof Error && err.message === 'Request body too large') {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload Too Large');
          return;
        }
        throw err;
      }

      // Return 415 if POST with non-JSON body
      if (req.method === 'POST' && body === null) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
        return;
      }

      const rawSessionId = req.headers['mcp-session-id'];
      const existingSessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;

      if (existingSessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existingSessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid session ID format' }));
        return;
      }

      let session = existingSessionId ? sessions.get(existingSessionId) : undefined;

      if (existingSessionId && !sessions.has(existingSessionId)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Session not found');
        return;
      }

      if (session?.closing) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session is closing' }));
        return;
      }

      if (!session) {
        if (sessions.size >= mcpConfig.max_sessions) {
          // LRU eviction: remove the session with the oldest lastActivityAt timestamp
          let oldestId: string | undefined;
          let earliestTime = Infinity;
          for (const [id, s] of sessions) {
            if (s.lastActivityAt < earliestTime) {
              earliestTime = s.lastActivityAt;
              oldestId = id;
            }
          }
          if (oldestId !== undefined) {
            const evicted = sessions.get(oldestId);
            if (evicted) void evicted.transport.close();
            sessions.delete(oldestId);
            logger.debug({ sessionId: oldestId }, '[mcp] Evicted oldest session (LRU)');
          }
        }
        // Create server BEFORE transport so the closure can safely capture it
        const sessionServer = buildServer();
        // Use a temporary key so the session is reachable before onsessioninitialized fires.
        const tempKey = `pending-${randomUUID()}`;
        // Shared handle so the onsessioninitialized closure can cancel the cleanup timer.
        const pendingCleanup: { timeout: ReturnType<typeof setTimeout> | null } = { timeout: null };

        const sessionTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            // Cancel the pending-session cleanup timer and move to the real session ID.
            if (pendingCleanup.timeout !== null) {
              clearTimeout(pendingCleanup.timeout);
              pendingCleanup.timeout = null;
            }
            sessions.delete(tempKey);
            sessions.set(id, {
              server: sessionServer,
              transport: sessionTransport,
              lastActivityAt: Date.now(),
              toolCallCost: 0,
              closing: false,
            });
          },
        });

        session = {
          server: sessionServer,
          transport: sessionTransport,
          lastActivityAt: Date.now(),
          toolCallCost: 0,
          closing: false,
        };
        // Store immediately under temp key so concurrent requests can find this session.
        sessions.set(tempKey, session);

        // Delete pending sessions that never completed initialization after 30 seconds.
        pendingCleanup.timeout = setTimeout(() => {
          if (sessions.has(tempKey)) {
            sessions.delete(tempKey);
          }
        }, 30_000);

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await sessionServer.connect(sessionTransport as any);
        } catch (err) {
          sessions.delete(tempKey);
          if (pendingCleanup.timeout !== null) {
            clearTimeout(pendingCleanup.timeout);
            pendingCleanup.timeout = null;
          }
          throw err;
        }
      }

      // Update activity timestamp for existing sessions
      if (existingSessionId) {
        session.lastActivityAt = Date.now();
      }

      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: invalid JSON');
        return;
      }

      // Check if this is a tool call and enforce per-session weighted cost limit
      const parsedObj = parsed as Record<string, unknown> | undefined;
      if (parsedObj?.['method'] === 'tools/call') {
        const toolName = parsedObj?.['params'] && typeof parsedObj['params'] === 'object'
          ? (parsedObj['params'] as Record<string, unknown>)['name']
          : undefined;
        const weight = typeof toolName === 'string' ? TOOL_CALL_WEIGHTS[toolName] ?? 1 : 1;
        session.toolCallCost += weight;
        if (session.toolCallCost > mcpConfig.session_cost_limit) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Tool call limit exceeded for this session' }));
          return;
        }
      }

      await session.transport.handleRequest(req, res, parsed);
    })();
  });

  // Slowloris hardening — bound time spent reading headers/body
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    // Bind to localhost only — prevent network exposure
    httpServer.listen(port, '127.0.0.1', () => {
      process.stderr.write(
        `[korinfra] WARNING: MCP HTTP transport is unencrypted (plain HTTP).\n` +
          `[korinfra]          Auth token and resource data travel in plaintext between client and server.\n` +
          `[korinfra]          Do not expose port ${port} over the network without a TLS-terminating proxy.\n` +
          `[korinfra]          For remote access use an SSH tunnel: ssh -L ${port}:localhost:${port} user@host\n`,
      );
      process.stderr.write(`[korinfra] MCP server listening on http://localhost:${port}\n`);
      process.stderr.write(
        `[korinfra] NOTE: designed for one trusted client at a time; concurrent clients share state.\n` +
          `[korinfra]       For isolated sessions, start separate servers on different ports.\n`,
      );
      resolve();
    });
    httpServer.once('error', reject);
  });

  // Keep running until SIGINT/SIGTERM
  await waitForShutdown();
  const results = await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
  for (const result of results) {
    if (result.status === 'rejected') {
      // Redact error before writing to stderr
      const safeMsg = redact(
        result.reason instanceof Error ? result.reason.message : String(result.reason),
        'moderate',
      );
      process.stderr.write(`[korinfra:mcp] session close error: ${safeMsg}\n`);
    }
  }
  await new Promise<void>((resolveClose) => {
    httpServer.close(() => resolveClose());
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage, maxSize: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] ?? '';
    const isJson = contentType.includes('application/json');
    const declaredLen = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLen) && declaredLen > maxSize) {
      reject(new Error('Request body too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      if (isJson) chunks.push(chunk);
    });
    req.on('end', () => resolve(isJson ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', reject);
  });
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => resolve();
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  });
}
