// The teacher's sign-in on this device: the rt server's teacher token (12 hours, spec risk
// "교사 토큰 저장": strict CSP, only the GIS script from outside) and the name to show.
// Pure helpers with the storage passed in, so they can be unit tested.

export const TEACHER_AUTH_KEY = 'jigsaw-teacher';
// A token this close to its end is treated as expired (no request fails half way).
const EXPIRY_MARGIN_MS = 60_000;

const fromBase64Url = (text) => atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));

// Expiry (ms) written in a token from the rt server (server/src/teacher-token.js), or null.
// The signature is checked by the server; the screen only reads when to ask for sign-in again.
export function tokenExpiry(token) {
  if (typeof token !== 'string') return null;
  const [body] = token.split('.');
  try {
    const { exp } = JSON.parse(fromBase64Url(body));
    return Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * @param {Storage} storage
 * @returns {{ token: string, displayName: string } | null}  null (and forgotten) when missing,
 *   broken or expired
 */
export function readTeacherAuth(storage, now = Date.now()) {
  let saved = null;
  try {
    saved = JSON.parse(storage.getItem(TEACHER_AUTH_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  const expiry = tokenExpiry(saved?.token);
  if (!saved || expiry === null || expiry - now < EXPIRY_MARGIN_MS) {
    if (saved !== null || storage.getItem(TEACHER_AUTH_KEY) !== null) storage.removeItem(TEACHER_AUTH_KEY);
    return null;
  }
  return { token: saved.token, displayName: typeof saved.displayName === 'string' ? saved.displayName : '' };
}

export function saveTeacherAuth(storage, { token, displayName }) {
  storage.setItem(TEACHER_AUTH_KEY, JSON.stringify({ token, displayName: displayName ?? '' }));
}

export function clearTeacherAuth(storage) {
  storage.removeItem(TEACHER_AUTH_KEY);
}

// The bar's name: '김교실 선생님', or just '선생님' before a name is known.
export function teacherLabel(displayName) {
  const name = (displayName ?? '').trim();
  return name ? `${name} 선생님` : '선생님';
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Google sign-in nonce: Google gets the SHA-256 (hex) of `raw`, the rt server gets `raw` and
// Supabase compares the two (signInWithIdToken).
export async function makeNonce(cryptoApi = globalThis.crypto) {
  const raw = hex(cryptoApi.getRandomValues(new Uint8Array(32)));
  const hashed = hex(await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  return { raw, hashed };
}
