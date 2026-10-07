// What a student device remembers about a class it joined, under one key per class code:
// the name it entered and the student token the rt server gave it (POST /api/join), so
// reopening the page goes straight back in with the same name, group and tray (spec D9).
// The name stays on this device and in the rt server's memory only (spec D14). The entry is
// removed when the class ends (the screen is told, or the server no longer knows the token),
// or after 24 hours (every class is closed by then).
import { normalizeName } from './names.js';

export const SAVED_PREFIX = 'jigsaw-student:';
// Before T22 one entry (anonymous Supabase account) lived here; it is removed when seen.
const OLD_KEY = 'jigsaw-student';
const VERSION = 2;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CODE = /^\d{6}$/;
// Tokens are 32 random bytes in base64url (server/src/engine/registry.js).
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

export const savedKey = (code) => `${SAVED_PREFIX}${code}`;

function parse(raw, code, now) {
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!entry || entry.v !== VERSION || entry.code !== code) return null;
  const fresh = Number.isFinite(entry.savedAt) && entry.savedAt <= now && now - entry.savedAt < MAX_AGE_MS;
  const name = normalizeName(entry.name);
  if (!fresh || !name || typeof entry.token !== 'string' || !TOKEN.test(entry.token)) return null;
  return { name, code, token: entry.token, savedAt: entry.savedAt };
}

function remove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // nothing to remove
  }
}

/** The saved class of this code, or null. An expired or broken entry is removed on the way. */
export function readSaved(storage, code, now = Date.now()) {
  if (!CODE.test(code ?? '')) return null;
  let raw = null;
  try {
    raw = storage.getItem(savedKey(code));
  } catch {
    return null;
  }
  if (raw === null) return null;
  const saved = parse(raw, code, now);
  if (!saved) {
    remove(storage, savedKey(code));
    return null;
  }
  const { savedAt: _savedAt, ...rest } = saved;
  return rest;
}

/** The most recently saved class on this device (home page '이어서 하기', /play), or null. */
export function latestSaved(storage, now = Date.now()) {
  let codes = [];
  try {
    remove(storage, OLD_KEY);
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(SAVED_PREFIX)) codes.push(key.slice(SAVED_PREFIX.length));
    }
  } catch {
    return null;
  }
  codes = codes.filter((code) => CODE.test(code));
  let best = null;
  for (const code of codes) {
    let raw = null;
    try {
      raw = storage.getItem(savedKey(code));
    } catch {
      continue;
    }
    const saved = raw === null ? null : parse(raw, code, now);
    if (!saved) remove(storage, savedKey(code));
    else if (!best || saved.savedAt > best.savedAt) best = saved;
  }
  if (!best) return null;
  const { savedAt: _savedAt, ...rest } = best;
  return rest;
}

export function writeSaved(storage, { name, code, token }, now = Date.now()) {
  if (!CODE.test(code ?? '')) return;
  const entry = { v: VERSION, name: normalizeName(name), code, token, savedAt: now };
  try {
    storage.setItem(savedKey(code), JSON.stringify(entry));
  } catch {
    // Private mode or full storage: the class still works, only coming back does not.
  }
}

export function clearSaved(storage, code) {
  if (CODE.test(code ?? '')) remove(storage, savedKey(code));
}
