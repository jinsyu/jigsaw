// Names from Realtime Presence on session:<id>. Students track { member, name } under
// their own user id as the Presence key. Keys and payloads are chosen by the client and
// the server does not check them, so a name is shown only when the key is the user id of
// a members row we read from the database and the payload names that same row.
import { normalizeName } from './names.js';

/**
 * @param {Record<string, Array<{ member?: unknown, name?: unknown }>>} state  channel.presenceState()
 * @param {Array<{ id: number, user_id: string }>} members  rows readable by this client
 * @returns {{ names: Map<number, string>, unknownKeys: string[] }}
 *   names: member id -> name for members online now; unknownKeys: keys matching no row
 *   (a student who joined after our last read, or a made-up key).
 */
export function presenceNames(state, members) {
  const byUser = new Map(members.map((m) => [m.user_id, m]));
  const names = new Map();
  const unknownKeys = [];
  for (const [key, metas] of Object.entries(state ?? {})) {
    const member = byUser.get(key);
    if (!member) {
      unknownKeys.push(key);
      continue;
    }
    // The latest entry wins: the same device in a second tab tracks again.
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (Number(meta?.member) !== member.id) continue;
      const name = normalizeName(meta?.name);
      if (name) names.set(member.id, name);
    }
  }
  return { names, unknownKeys };
}
