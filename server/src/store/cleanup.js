// The clean-up job (every CLEANUP_INTERVAL_MS inside the rt server; replaces pg_cron):
// 1. open classes 24 hours after they started (never started: after they were created) are
//    closed in memory with registry.end and saved as ended (members deleted, tokens dead);
//    open rows that are not in memory (should not happen) are ended in the database too;
// 2. members of ended classes are deleted;
// 3. classes ended more than 30 days ago are deleted (groups and members go with them).
// auth.users, teachers and images are never touched here.
import { OPEN_LIMIT_MS } from '../engine/registry.js';

export const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
export const KEEP_ENDED_MS = 30 * 24 * 60 * 60 * 1000;

async function data(promise) {
  const { data: rows, error } = await promise;
  if (error) throw error;
  return rows;
}

/**
 * @param {object} options
 * @param {ReturnType<import('../engine/registry.js').createRegistry>} options.registry
 * @param {ReturnType<import('./persistence.js').createPersistence>} options.persistence
 * @param {import('@supabase/supabase-js').SupabaseClient} options.db
 * @param {() => number} [options.now]
 * @param {(closed: object) => void} [options.onClosed]  broadcasts the 'end' events
 */
export async function runCleanup({ registry, persistence, db, now = Date.now, onClosed = () => {} }) {
  const closed = registry.expireStale();
  for (const c of closed) {
    await persistence.saveSession(c.session);
    onClosed(c);
  }

  const t = now();
  const limit = new Date(t - OPEN_LIMIT_MS).toISOString();
  const stale = await data(
    db
      .from('sessions')
      .select('id')
      .neq('status', 'ended')
      .or(`started_at.lt.${limit},and(started_at.is.null,created_at.lt.${limit})`),
  );
  const orphans = stale.map((r) => r.id).filter((id) => registry.session(id) === null);
  if (orphans.length > 0) {
    await data(
      db.from('sessions').update({ status: 'ended', ended_at: new Date(t).toISOString() }).in('id', orphans).select('id'),
    );
  }

  const withMembers = [...new Set((await data(db.from('members').select('session_id'))).map((r) => r.session_id))];
  let endedWithMembers = [];
  if (withMembers.length > 0) {
    endedWithMembers = (await data(db.from('sessions').select('id').eq('status', 'ended').in('id', withMembers))).map(
      (r) => r.id,
    );
  }
  let deletedMembers = 0;
  if (endedWithMembers.length > 0) {
    deletedMembers = (await data(db.from('members').delete().in('session_id', endedWithMembers).select('id'))).length;
  }

  const old = new Date(t - KEEP_ENDED_MS).toISOString();
  const deletedSessions = (await data(db.from('sessions').delete().eq('status', 'ended').lt('ended_at', old).select('id')))
    .length;

  return { closed: closed.length + orphans.length, deletedMembers, deletedSessions };
}

// Runs runCleanup every CLEANUP_INTERVAL_MS; a failed run is logged and the next one tries again.
export function startCleanup(options, { log = console, timers = { setInterval, clearInterval } } = {}) {
  const handle = timers.setInterval(() => {
    runCleanup(options).catch((error) => log.error(`[cleanup] 실패: ${error?.code ?? ''} ${error?.message ?? error}`));
  }, CLEANUP_INTERVAL_MS);
  return () => timers.clearInterval(handle);
}
