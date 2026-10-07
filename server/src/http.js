// HTTP routes of the rt server (socket.io answers /socket.io/ itself).
//   GET    /health                 version, uptime and counts (no secrets; no Origin needed)
//   POST   /api/join               { code, name, token? } -> { ok, sessionId, memberId, token, status, group, color }
//   POST   /api/teacher/login      { idToken, nonce } -> { ok, token, teacher } | { ok, needsStart, startTicket, profile }
//   POST   /api/teacher/start      { startTicket, displayName, agreed: true } -> { ok, token, teacher }
//   GET    /api/sessions           my classes                                  (teacher token)
//   POST   /api/sessions           { pieceCount, groupCount, picture, hints } -> { ok, sessionId, code }
//   GET    /api/images             my pictures with signed URLs
//   POST   /api/images             WebP bytes (Content-Type image/webp) -> { ok, image }
//   GET    /api/images/:id/url     a fresh signed URL of my picture
//   DELETE /api/images/:id         refused while an open class uses it
//   local only (RT_TEST_HOOKS=1, never in production):
//   POST   /api/test/clock         { advanceMs }  moves the engine clock and runs the timers
//   POST   /api/dev/teacher-token  { teacherId }  a teacher token for a seeded local teacher
// /api/* needs an allowed Origin (CORS). Teacher routes need "Authorization: Bearer <token>"
// of an account in jigsaw.teachers. Requests per address are limited and bodies are capped.
import { readFileSync } from 'node:fs';
import { imagePath, MAX_BYTES as MAX_IMAGE_BYTES } from './teacher/images.js';
import { createWindowLimiter, createWrongCodeGuard } from './limits.js';
import { clientAddress } from './sockets.js';
import { signStartTicket, signTeacherToken, verifyStartTicket, verifyTeacherToken } from './teacher-token.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const JOIN_STATUS = { invalid_code: 404, invalid_name: 400, class_full: 409 };
const CREATE_STATUS = { too_many_sessions: 429, no_free_code: 503 };
const UPLOAD_STATUS = { too_large: 413, too_many_images: 409 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/gu;
export const TEACHER_NAME_MAX = 40;

export class HttpError extends Error {
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

function readBody(req, { maxBytes, type }) {
  return new Promise((resolve, reject) => {
    if (!type.test(req.headers['content-type'] ?? '')) {
      reject(new HttpError(415, 'unsupported_type'));
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, maxBytes) {
  const raw = await readBody(req, { maxBytes, type: /^application\/json\b/i });
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'bad_request');
  }
}

export function teacherName(value) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(HIDDEN_CHARS, '').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, TEACHER_NAME_MAX).join('').trim();
}

/**
 * @param {object} deps
 * @param {(input: { idToken: string, nonce: string }) => Promise<{ uid: string, email: string|null }>} deps.verifyIdToken
 * @param {ReturnType<import('./teacher/teachers.js').createTeachers>} deps.teachers
 * @param {ReturnType<import('./teacher/images.js').createImages>} deps.images
 * @param {Map<string, { width: number, height: number }>} deps.builtins
 */
export function createHttpHandler({
  config,
  registry,
  persistence,
  sockets,
  db,
  teachers,
  images,
  builtins,
  verifyIdToken,
  now,
  startedAt,
  state,
  log = console,
}) {
  const { limits } = config;
  const perAddress = createWindowLimiter({ limit: limits.httpPerMinute, windowMs: 60_000, now });
  const wrongCodes = createWrongCodeGuard({
    limit: limits.wrongCodes,
    bonusPerJoin: limits.wrongCodeBonusPerJoin,
    windowMs: limits.wrongCodeWindowMs,
    blockMs: limits.wrongCodeBlockMs,
    now,
  });
  // Uploads per teacher per hour (the shared Storage is not one teacher's).
  const uploads = createWindowLimiter({ limit: limits.uploadsPerHour, windowMs: 60 * 60 * 1000, now });
  const ok = (res, req, body) => send(res, 200, { ok: true, ...body }, corsHeaders(req));

  function corsHeaders(req) {
    return { 'access-control-allow-origin': req.headers.origin, vary: 'Origin' };
  }

  // The uid of a jigsaw teacher from the Authorization header.
  async function requireTeacher(req) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const uid = match ? verifyTeacherToken(match[1], config.sessionSecret, now()) : null;
    if (!uid) throw new HttpError(401, 'invalid_token');
    if (!(await teachers.isTeacher(uid))) throw new HttpError(403, 'not_teacher');
    return uid;
  }

  const issueToken = (uid) => signTeacherToken(uid, config.sessionSecret, { now: now() });

  function health(req, res) {
    send(res, 200, {
      ok: true,
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      sessions: registry.openCount,
      connections: sockets().connectionCount,
    });
  }

  async function join(req, res, { address }) {
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

  async function login(req, res) {
    const body = await readJson(req, 8192);
    if (typeof body.idToken !== 'string' || typeof body.nonce !== 'string' || !body.idToken || !body.nonce) {
      throw new HttpError(400, 'bad_request');
    }
    let account;
    try {
      account = await verifyIdToken({ idToken: body.idToken, nonce: body.nonce });
    } catch {
      throw new HttpError(401, 'invalid_id_token');
    }
    const profile = await teachers.profile(account.uid);
    if (await teachers.isTeacher(account.uid)) {
      return ok(res, req, { token: issueToken(account.uid), teacher: { uid: account.uid, displayName: profile?.displayName ?? null } });
    }
    return ok(res, req, {
      needsStart: true,
      startTicket: signStartTicket(account.uid, config.sessionSecret, { now: now() }),
      profile: { displayName: profile?.displayName ?? null },
    });
  }

  async function start(req, res) {
    const body = await readJson(req, limits.bodyBytes);
    const uid = verifyStartTicket(body.startTicket, config.sessionSecret, now());
    if (!uid) throw new HttpError(401, 'invalid_token');
    if (body.agreed !== true) throw new HttpError(400, 'terms_required');
    const displayName = teacherName(body.displayName);
    if (!displayName) throw new HttpError(400, 'invalid_name');
    await teachers.start(uid, displayName);
    ok(res, req, { token: issueToken(uid), teacher: { uid, displayName } });
  }

  async function listSessions(req, res) {
    const uid = await requireTeacher(req);
    const { data, error } = await db
      .from('sessions')
      .select(
        'id, code, status, builtin_key, image_id, piece_count, created_at, started_at, ended_at, ' +
          'hint_preview, hint_outline, hint_picture_button, hint_underlay, groups(count)',
      )
      .eq('teacher_id', uid)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    ok(res, req, {
      sessions: data.map((s) => ({
        id: s.id,
        code: s.code,
        status: s.status,
        builtinKey: s.builtin_key,
        imageId: s.image_id,
        pieceCount: s.piece_count,
        groupCount: s.groups?.[0]?.count ?? 0,
        hints: {
          preview: s.hint_preview,
          outline: s.hint_outline,
          pictureButton: s.hint_picture_button,
          underlay: s.hint_underlay,
        },
        createdAt: s.created_at,
        startedAt: s.started_at,
        endedAt: s.ended_at,
      })),
    });
  }

  async function createSession(req, res) {
    const uid = await requireTeacher(req);
    const body = await readJson(req, limits.bodyBytes);
    const requested = typeof body.picture === 'object' && body.picture !== null ? body.picture : {};
    let picture = null;
    if (typeof requested.builtinKey === 'string' && requested.imageId == null) {
      const size = builtins.get(requested.builtinKey);
      if (size) picture = { builtinKey: requested.builtinKey, aspect: size.width / size.height };
    } else if (typeof requested.imageId === 'string' && requested.builtinKey == null && UUID.test(requested.imageId)) {
      const image = await images.own(uid, requested.imageId);
      if (image) picture = { imageId: image.id, width: image.width, height: image.height };
    }
    if (!picture) throw new HttpError(400, 'invalid_picture');
    const { result } = registry.createSession(uid, {
      pieceCount: body.pieceCount,
      groupCount: body.groupCount,
      picture,
      hints: body.hints,
    });
    if (!result.ok) throw new HttpError(CREATE_STATUS[result.error] ?? 400, result.error);
    if (picture.imageId) await images.touch(picture.imageId);
    const saved = await persistence.saveSession(registry.session(result.sessionId));
    if (!saved) log.error(`[http] 새 수업 ${result.sessionId} 저장을 다시 시도합니다`);
    ok(res, req, { sessionId: result.sessionId, code: result.code });
  }

  async function listImages(req, res) {
    const uid = await requireTeacher(req);
    ok(res, req, { images: await images.list(uid) });
  }

  async function uploadImage(req, res) {
    const uid = await requireTeacher(req);
    if (!uploads.hit(uid)) throw new HttpError(429, 'too_many_uploads');
    const bytes = await readBody(req, { maxBytes: MAX_IMAGE_BYTES, type: /^image\/webp\b/i });
    const result = await images.upload(uid, new Uint8Array(bytes));
    if (!result.ok) throw new HttpError(UPLOAD_STATUS[result.error] ?? 400, result.error);
    ok(res, req, { image: result.image });
  }

  async function imageUrl(req, res, { params }) {
    const uid = await requireTeacher(req);
    const image = UUID.test(params.id) ? await images.own(uid, params.id) : null;
    if (!image) throw new HttpError(404, 'not_found');
    ok(res, req, { url: await images.urlFor(imagePath(uid, image.id)) });
  }

  async function deleteImage(req, res, { params }) {
    const uid = await requireTeacher(req);
    if (!UUID.test(params.id)) throw new HttpError(404, 'not_found');
    const result = await images.remove(uid, params.id);
    if (!result.ok) throw new HttpError(result.error === 'image_in_use' ? 409 : 404, result.error);
    ok(res, req, {});
  }

  async function testClock(req, res) {
    const body = await readJson(req, limits.bodyBytes);
    if (!Number.isFinite(body.advanceMs) || body.advanceMs < 0) throw new HttpError(400, 'bad_request');
    now.advance(body.advanceMs);
    sockets().deliverTagged(registry.tick());
    ok(res, req, { now: now() });
  }

  async function devTeacherToken(req, res) {
    const body = await readJson(req, limits.bodyBytes);
    if (typeof body.teacherId !== 'string' || !(await teachers.isTeacher(body.teacherId))) {
      throw new HttpError(404, 'not_found');
    }
    ok(res, req, { token: issueToken(body.teacherId) });
  }

  // [method, pattern, handler]; ':id' matches one path segment.
  const routes = [
    ['POST', '/api/join', join],
    ['POST', '/api/teacher/login', login],
    ['POST', '/api/teacher/start', start],
    ['GET', '/api/sessions', listSessions],
    ['POST', '/api/sessions', createSession],
    ['GET', '/api/images', listImages],
    ['POST', '/api/images', uploadImage],
    ['GET', '/api/images/:id/url', imageUrl],
    ['DELETE', '/api/images/:id', deleteImage],
  ];
  if (config.testHooks) {
    routes.push(['POST', '/api/test/clock', testClock], ['POST', '/api/dev/teacher-token', devTeacherToken]);
  }
  const compiled = routes.map(([method, pattern, fn]) => {
    const names = [];
    const source = pattern.replace(/:(\w+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    return { method, regex: new RegExp(`^${source}$`), names, fn };
  });

  function route(method, path) {
    let pathMatched = false;
    for (const r of compiled) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      try {
        return { fn: r.fn, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
      } catch {
        throw new HttpError(404, 'not_found'); // a broken %-escape
      }
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found');
  }

  async function handle(req, res) {
    try {
      if (state.closing) throw new HttpError(503, 'shutting_down');
      const address = clientAddress(req, config.trustProxy);
      if (!perAddress.hit(address)) throw new HttpError(429, 'rate_limited');
      const path = new URL(req.url, 'http://rt.local').pathname;
      if (req.method === 'GET' && path === '/health') return health(req, res);
      if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found');

      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'forbidden_origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...corsHeaders(req),
          'access-control-allow-methods': 'GET, POST, DELETE',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '600',
        });
        return res.end();
      }
      const { fn, params } = route(req.method, path);
      return await fn(req, res, { address, params });
    } catch (error) {
      if (res.headersSent) return undefined;
      if (error instanceof HttpError) {
        const origin = req.headers.origin;
        const cors = typeof origin === 'string' && config.allowedOrigins.includes(origin) ? corsHeaders(req) : {};
        return send(res, error.status, { ok: false, error: error.message }, cors);
      }
      log.error(`[http] ${req.method} 처리 실패: ${error?.code ?? ''} ${error?.message ?? error}`);
      return send(res, 500, { ok: false, error: 'server_error' });
    }
  }

  // Forgets old counters (called every minute).
  function prune() {
    perAddress.prune();
    wrongCodes.prune();
    uploads.prune();
  }

  return { handle, prune };
}
