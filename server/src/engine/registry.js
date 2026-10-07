// Every open class (waiting or playing) of the rt server, by id, by code and by student token.
//
// - createSession picks a 6-digit code no other open class uses, and a seed.
// - join(code, { name, token }) gives a new student a member id and a random token; only the
//   token's hash is kept. The same token again returns the same member (same device).
// - end(id) closes the class: its code is free again and its tokens stop working.
// Wrong-code throttling is per IP and belongs to the network layer (T19).
import { createHash, randomBytes, randomInt as cryptoRandomInt, randomUUID } from 'node:crypto';
import { PIECE_COUNTS, gridFor } from '../../../public/js/puzzle/geometry.js';
import { normalizeHints } from '../../../public/js/store/puzzle-store.js';
import { normalizeName } from '../../../public/js/student/names.js';
import { createClassSession } from './session.js';

export const MAX_GROUPS = 12;
export const MAX_OPEN_SESSIONS = 100;
const CODE_SPACE = 1_000_000;
const CODE_ATTEMPTS = 20;
const BUILTIN_KEY = /^[a-z0-9-]{1,64}$/;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

const fail = (error) => ({ result: { ok: false, error }, events: [] });
const positive = (n) => Number.isFinite(n) && n > 0;

// { builtinKey, aspect } or { imageId, width, height } -> { builtinKey, imageId, aspect } or null.
function pictureOf(picture) {
  const { builtinKey, imageId, aspect, width, height } = picture ?? {};
  if (builtinKey != null && imageId == null) {
    if (typeof builtinKey !== 'string' || !BUILTIN_KEY.test(builtinKey) || !positive(aspect)) return null;
    return { builtinKey, imageId: null, aspect };
  }
  if (imageId != null && builtinKey == null) {
    if (typeof imageId !== 'string' || !positive(width) || !positive(height)) return null;
    return { builtinKey: null, imageId, aspect: width / height };
  }
  return null;
}

/**
 * @param {object} options
 * @param {() => number} options.now
 * @param {() => number} [options.random]  dealing and random groups
 * @param {(min: number, max: number) => number} [options.randomInt]  codes and seeds
 * @param {() => string} [options.newId]
 * @param {() => string} [options.newToken]
 * @param {number} [options.maxOpenSessions]
 */
export function createRegistry({
  now,
  random = Math.random,
  randomInt = cryptoRandomInt,
  newId = randomUUID,
  newToken = () => randomBytes(32).toString('base64url'),
  maxOpenSessions = MAX_OPEN_SESSIONS,
}) {
  const sessions = new Map(); // id -> session (open only)
  const byCode = new Map(); // code -> session
  const byTokenHash = new Map(); // hash -> { session, memberId }

  function freeCode() {
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = String(randomInt(0, CODE_SPACE)).padStart(6, '0');
      if (!byCode.has(code)) return code;
    }
    return null;
  }

  function createSession(teacherId, { pieceCount, groupCount, picture, hints } = {}) {
    if (!PIECE_COUNTS.includes(pieceCount)) return fail('invalid_piece_count');
    if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount > MAX_GROUPS) return fail('invalid_group_count');
    const pic = pictureOf(picture);
    if (!pic) return fail('invalid_picture');
    if (sessions.size >= maxOpenSessions) return fail('too_many_sessions');
    const code = freeCode();
    if (code === null) return fail('no_free_code');
    const { cols, rows } = gridFor(pieceCount, pic.aspect);
    const session = createClassSession({
      id: newId(),
      teacherId,
      code,
      seed: randomInt(1, 2 ** 32),
      pieceCount,
      cols,
      rows,
      ...pic,
      hints: normalizeHints(hints),
      groupCount,
      now,
      random,
    });
    sessions.set(session.id, session);
    byCode.set(code, session);
    return { result: { ok: true, sessionId: session.id, code }, events: [] };
  }

  function join(code, { name, token } = {}) {
    const session = typeof code === 'string' ? byCode.get(code) : undefined;
    if (!session) return fail('invalid_code');
    const clean = normalizeName(name);
    if (!clean) return fail('invalid_name');

    const known = typeof token === 'string' ? byTokenHash.get(hashToken(token)) : undefined;
    let member;
    let memberToken = token;
    if (known && known.session === session) {
      member = session.member(known.memberId);
      // After a server restart the name is gone from memory; the device sends it again.
      session.rename(member.id, clean);
    } else {
      memberToken = newToken();
      const tokenHash = hashToken(memberToken);
      member = session.addMember({ id: newId(), name: clean, tokenHash });
      byTokenHash.set(tokenHash, { session, memberId: member.id });
    }
    return {
      result: {
        ok: true,
        sessionId: session.id,
        memberId: member.id,
        token: memberToken,
        status: session.status,
        group: member.group,
        color: member.color,
      },
      events: [session.joinEvent(member)],
    };
  }

  // A socket's student token -> { session, memberId }, or null (unknown, or the class ended).
  function byToken(token) {
    if (typeof token !== 'string') return null;
    return byTokenHash.get(hashToken(token)) ?? null;
  }

  function end(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return fail('not_found');
    const outcome = session.end();
    sessions.delete(sessionId);
    byCode.delete(session.code);
    for (const [hash, entry] of byTokenHash) if (entry.session === session) byTokenHash.delete(hash);
    return outcome;
  }

  // Timers of every open class: events tagged with their session id.
  function tick() {
    return [...sessions.values()].flatMap((s) => s.tick().map((event) => ({ sessionId: s.id, ...event })));
  }

  return {
    createSession,
    join,
    byToken,
    end,
    tick,
    session: (sessionId) => sessions.get(sessionId) ?? null,
    get openCount() {
      return sessions.size;
    },
  };
}
