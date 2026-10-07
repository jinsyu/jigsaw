import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TEACHER_AUTH_KEY,
  clearTeacherAuth,
  makeNonce,
  readTeacherAuth,
  saveTeacherAuth,
  teacherLabel,
  tokenExpiry,
} from '../../public/js/teacher/auth.js';
import { signTeacherToken } from '../../server/src/teacher-token.js';

const SECRET = 'x'.repeat(32);
const NOW = Date.parse('2026-10-08T09:00:00Z');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

describe('teacher sign-in on this device', () => {
  it('reads the expiry the rt server wrote in its token (12 hours)', () => {
    const token = signTeacherToken('u1', SECRET, { now: NOW });
    expect(tokenExpiry(token)).toBe(NOW + 12 * 60 * 60 * 1000);
    expect(tokenExpiry('garbage')).toBeNull();
    expect(tokenExpiry(null)).toBeNull();
  });

  it('keeps the token and the name, and gives them back while the token lasts', () => {
    const storage = memoryStorage();
    const token = signTeacherToken('u1', SECRET, { now: NOW });
    saveTeacherAuth(storage, { token, displayName: '김교실' });
    expect(readTeacherAuth(storage, NOW + 60_000)).toEqual({ token, displayName: '김교실' });
    clearTeacherAuth(storage);
    expect(storage.getItem(TEACHER_AUTH_KEY)).toBeNull();
  });

  it('forgets an expired, nearly expired or broken sign-in (the teacher signs in again)', () => {
    const storage = memoryStorage();
    const token = signTeacherToken('u1', SECRET, { now: NOW });
    saveTeacherAuth(storage, { token, displayName: '김교실' });
    expect(readTeacherAuth(storage, NOW + 12 * 60 * 60 * 1000 - 30_000)).toBeNull();
    expect(storage.getItem(TEACHER_AUTH_KEY)).toBeNull();
    storage.setItem(TEACHER_AUTH_KEY, '{not json');
    expect(readTeacherAuth(storage, NOW)).toBeNull();
    expect(storage.getItem(TEACHER_AUTH_KEY)).toBeNull();
    storage.setItem(TEACHER_AUTH_KEY, JSON.stringify({ token: 'abc' }));
    expect(readTeacherAuth(storage, NOW)).toBeNull();
  });

  it('labels the bar with the name, or just 선생님', () => {
    expect(teacherLabel('김교실')).toBe('김교실 선생님');
    expect(teacherLabel('  ')).toBe('선생님');
    expect(teacherLabel(null)).toBe('선생님');
  });

  it('makes a fresh nonce: Google gets the SHA-256 of what the rt server gets', async () => {
    const a = await makeNonce(webcrypto);
    const b = await makeNonce(webcrypto);
    expect(a.raw).toMatch(/^[0-9a-f]{64}$/);
    expect(a.raw).not.toBe(b.raw);
    const hashed = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(a.raw))).toString('hex');
    expect(a.hashed).toBe(hashed);
  });
});
