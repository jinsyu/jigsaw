// What a student device remembers between visits to the same class: the class code, the
// name it entered and the members row it got, so reopening the page returns to the same
// name and group. The name stays on this device only (spec D14) and is removed with the
// rest when the class ends, or after 24 hours (members rows are gone by then anyway).
import { normalizeName } from './names.js';

export const SAVED_KEY = 'jigsaw-student';
const VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isId = (n) => Number.isSafeInteger(n) && n > 0;

function parse(raw, now) {
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!entry || entry.v !== VERSION) return null;
  const fresh = Number.isFinite(entry.savedAt) && entry.savedAt <= now && now - entry.savedAt < MAX_AGE_MS;
  const name = normalizeName(entry.name);
  const valid = /^\d{6}$/.test(entry.code ?? '') && isId(entry.sessionId) && isId(entry.memberId);
  if (!fresh || !name || !valid) return null;
  return { name, code: entry.code, sessionId: entry.sessionId, memberId: entry.memberId };
}

// Returns the saved class, or null. An expired or broken entry is removed on the way.
export function readSaved(storage, now = Date.now()) {
  let raw = null;
  try {
    raw = storage.getItem(SAVED_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const saved = parse(raw, now);
  if (!saved) clearSaved(storage);
  return saved;
}

export function writeSaved(storage, { name, code, sessionId, memberId }, now = Date.now()) {
  const entry = { v: VERSION, name: normalizeName(name), code, sessionId, memberId, savedAt: now };
  try {
    storage.setItem(SAVED_KEY, JSON.stringify(entry));
  } catch {
    // Private mode or full storage: the class still works, only coming back does not.
  }
}

export function clearSaved(storage) {
  try {
    storage.removeItem(SAVED_KEY);
  } catch {
    // nothing to remove
  }
}
