// Class requests of the teacher screens (rt server, server/src/http.js). The live parts of a
// class (students, groups, start, end, overview) go over its socket (session-live.js).
import { normalizeHints } from '../store/puzzle-store.js';

/**
 * My classes, newest first: { id, code, status, builtinKey, imageId, pieceCount, groupCount,
 * hints, createdAt, startedAt, endedAt }.
 */
export async function listSessions(api) {
  const { sessions } = await api.get('/api/sessions');
  return sessions.map((s) => ({ ...s, hints: normalizeHints(s.hints) }));
}

// picture: { builtinKey } or { imageId }; hints: puzzle-store Hints (missing = defaults).
// Resolves with { sessionId, code }.
export async function createSession(api, { picture, pieceCount, groupCount, hints = {} }) {
  const body = {
    pieceCount,
    groupCount,
    picture: picture.imageId ? { imageId: picture.imageId } : { builtinKey: picture.builtinKey },
    hints: normalizeHints(hints),
  };
  const { sessionId, code } = await api.post('/api/sessions', body);
  return { sessionId, code };
}
