// HTTP routes of the rt server (socket.io handles /socket.io/ itself).
//   GET  /health     version, uptime and counts (no secrets, no Origin needed: monitoring)
//   POST /api/join   { code, name, token? } -> { ok, sessionId, memberId, token, status, group, color }
//   local test hooks only (RT_TEST_HOOKS=1, never in production):
//   POST /api/test/clock     { advanceMs }  moves the engine clock forward and runs the timers
//   POST /api/test/sessions  { teacherId, pieceCount, groupCount, picture, hints } -> { sessionId, code }
// /api/* needs an allowed Origin (CORS). Requests per address are limited, bodies are capped,
// and wrong class codes from one address are refused for a while after too many.
import { readFileSync } from 'node:fs';
import { createWindowLimiter, createWrongCodeGuard } from './limits.js';
import { clientAddress } from './sockets.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const JOIN_STATUS = { invalid_code: 404, invalid_name: 400, class_full: 409 };

class HttpError extends Error {
  constructor(status, error) {
    super(error);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      reject(new HttpError(415, 'json_required'));
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, 'too_large'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
        resolve(value);
      } catch {
        reject(new HttpError(400, 'bad_request'));
      }
    });
    req.on('error', reject);
  });
}

export function createHttpHandler({ config, registry, persistence, sockets, now, startedAt, state, log = console }) {
  const { limits } = config;
  const perAddress = createWindowLimiter({ limit: limits.httpPerMinute, windowMs: 60_000, now });
  const wrongCodes = createWrongCodeGuard({
    limit: limits.wrongCodes,
    bonusPerJoin: limits.wrongCodeBonusPerJoin,
    windowMs: limits.wrongCodeWindowMs,
    blockMs: limits.wrongCodeBlockMs,
    now,
  });

  function health(res) {
    send(res, 200, {
      ok: true,
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      sessions: registry.openCount,
      connections: sockets().connectionCount,
    });
  }

  async function join(req, res, address) {
    if (wrongCodes.blocked(address)) throw new HttpError(429, 'too_many_attempts');
    const body = await readJson(req, limits.bodyBytes);
    const { result, events } = registry.join(typeof body.code === 'string' ? body.code : null, {
      name: body.name,
      token: typeof body.token === 'string' ? body.token : undefined,
    });
    if (!result.ok) {
      if (result.error === 'invalid_code') wrongCodes.fail(address);
      throw new HttpError(JOIN_STATUS[result.error] ?? 400, result.error);
    }
    wrongCodes.succeed(address);
    sockets().deliver(registry.session(result.sessionId), events);
    send(res, 200, result, corsHeaders(req));
  }

  async function testClock(req, res) {
    const body = await readJson(req, limits.bodyBytes);
    if (!Number.isFinite(body.advanceMs) || body.advanceMs < 0) throw new HttpError(400, 'bad_request');
    now.advance(body.advanceMs);
    sockets().deliverTagged(registry.tick());
    send(res, 200, { ok: true, now: now() }, corsHeaders(req));
  }

  async function testSession(req, res) {
    const body = await readJson(req, limits.bodyBytes);
    const { result } = registry.createSession(body.teacherId, body);
    if (!result.ok) throw new HttpError(400, result.error);
    await persistence.saveSession(registry.session(result.sessionId));
    send(res, 200, result, corsHeaders(req));
  }

  function corsHeaders(req) {
    return { 'access-control-allow-origin': req.headers.origin, vary: 'Origin' };
  }

  const routes = new Map([['POST /api/join', join]]);
  if (config.testHooks) {
    routes.set('POST /api/test/clock', testClock);
    routes.set('POST /api/test/sessions', testSession);
  }

  async function handle(req, res) {
    try {
      if (state.closing) throw new HttpError(503, 'shutting_down');
      const address = clientAddress(req, config.trustProxy);
      if (!perAddress.hit(address)) throw new HttpError(429, 'rate_limited');
      const path = new URL(req.url, 'http://rt.local').pathname;
      if (req.method === 'GET' && path === '/health') return health(res);
      if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found');

      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'forbidden_origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...corsHeaders(req),
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        });
        return res.end();
      }
      const route = routes.get(`${req.method} ${path}`);
      if (!route) throw new HttpError(404, 'not_found');
      return await route(req, res, address);
    } catch (error) {
      if (res.headersSent) return undefined;
      if (error instanceof HttpError) {
        const origin = req.headers.origin;
        const cors = typeof origin === 'string' && config.allowedOrigins.includes(origin) ? corsHeaders(req) : {};
        return send(res, error.status, { ok: false, error: error.message }, cors);
      }
      log.error(`[http] ${req.method} 처리 실패: ${error?.message ?? error}`);
      return send(res, 500, { ok: false, error: 'server_error' });
    }
  }

  // Forgets old counters (called every minute).
  function prune() {
    perAddress.prune();
    wrongCodes.prune();
  }

  return { handle, prune };
}
