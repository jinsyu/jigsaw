// Signed tokens of the rt server (HMAC-SHA256 with SESSION_SECRET). payload = { uid, exp, p }.
// - teacher token (p 'teacher', TEACHER_TOKEN_TTL_MS): sent with every teacher request.
// - start ticket (p 'start', START_TICKET_TTL_MS): from sign-in to '함께 퍼즐 시작하기' for a
//   gyosil account that is not a jigsaw teacher yet. It never works as a teacher token.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TEACHER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const START_TICKET_TTL_MS = 15 * 60 * 1000;

const mac = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

export function signTeacherToken(uid, secret, { now = Date.now(), ttlMs = TEACHER_TOKEN_TTL_MS, purpose = 'teacher' } = {}) {
  const body = Buffer.from(JSON.stringify({ uid, exp: now + ttlMs, p: purpose })).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function signStartTicket(uid, secret, { now = Date.now() } = {}) {
  return signTeacherToken(uid, secret, { now, ttlMs: START_TICKET_TTL_MS, purpose: 'start' });
}

// The uid, or null for a forged, broken, expired or wrong-purpose token.
export function verifyTeacherToken(token, secret, now = Date.now(), purpose = 'teacher') {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { uid, exp, p } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof uid !== 'string' || !uid || !Number.isFinite(exp) || exp <= now || p !== purpose) return null;
    return uid;
  } catch {
    return null;
  }
}

export const verifyStartTicket = (token, secret, now = Date.now()) => verifyTeacherToken(token, secret, now, 'start');
