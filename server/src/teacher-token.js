// Teacher session tokens: signed by the rt server with SESSION_SECRET (HMAC-SHA256), valid
// for TEACHER_TOKEN_TTL_MS. payload = { uid, exp }. T20 issues them after Google sign-in.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TEACHER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const mac = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

export function signTeacherToken(uid, secret, { now = Date.now(), ttlMs = TEACHER_TOKEN_TTL_MS } = {}) {
  const body = Buffer.from(JSON.stringify({ uid, exp: now + ttlMs })).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

// The teacher's uid, or null for a forged, broken or expired token.
export function verifyTeacherToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof uid !== 'string' || !uid || !Number.isFinite(exp) || exp <= now) return null;
    return uid;
  } catch {
    return null;
  }
}
