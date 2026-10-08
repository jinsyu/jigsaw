// The clean-up job (every CLEANUP_INTERVAL_MS inside the rt server; replaces pg_cron):
// 1. open classes 24 hours after they started (never started: after they were created), or
//    with no activity for 3 hours, are closed in memory with registry.end and saved as ended
//    (members deleted, tokens dead);
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
 * @param {number} [options.pageSize]  rows per read (PostgREST max rows)
 * @param {number} [options.chunkSize]  session ids per delete request
 */
export async function runCleanup({
  registry,
  persistence,
  db,
  now = Date.now,
  onClosed = () => {},
  pageSize = 1000,
  chunkSize = 100,
}) {
  const closed = registry.expireStale();
  for (const c of closed) {
    await persistence.saveSession(c.session);
    onClosed(c);
  }

  const t = now();
  const limit = new Date(t - OPEN_LIMIT_MS).toISOString();
  // At most pageSize per run; the next run takes the rest.
  const stale = await data(
    db
      .from('sessions')
      .select('id')
      .neq('status', 'ended')
      .or(`started_at.lt.${limit},and(started_at.is.null,created_at.lt.${limit})`)
      .limit(pageSize),
  );
  const orphans = stale.map((r) => r.id).filter((id) => registry.session(id) === null);
  if (orphans.length > 0) {
    await data(
      db.from('sessions').update({ status: 'ended', ended_at: new Date(t).toISOString() }).in('id', orphans).select('id'),
    );
  }

  // Ended classes page by page (PostgREST returns at most 1000 rows), members deleted in chunks
  // (ids go in the URL).
  let deletedMembers = 0;
  for (let from = 0; ; from += pageSize) {
    const page = (
      await data(db.from('sessions').select('id').eq('status', 'ended').order('id').range(from, from + pageSize - 1))
    ).map((r) => r.id);
    for (let i = 0; i < page.length; i += chunkSize) {
      const { count, error } = await db.from('members').delete({ count: 'exact' }).in('session_id', page.slice(i, i + chunkSize));
      if (error) throw error;
      deletedMembers += count ?? 0;
    }
    if (page.length < pageSize) break;
  }

  const old = new Date(t - KEEP_ENDED_MS).toISOString();
  const removed = await db.from('sessions').delete({ count: 'exact' }).eq('status', 'ended').lt('ended_at', old);
  if (removed.error) throw removed.error;
  const deletedSessions = removed.count ?? 0;

  return { closed: closed.length + orphans.length, deletedMembers, deletedSessions };
}

// Runs runCleanup every CLEANUP_INTERVAL_MS; a failed run is logged and the next one tries again.
export function startCleanup(options, { log = console, timers = { setInterval, clearInterval } } = {}) {
  const handle = timers.setInterval(() => {
    runCleanup(options).catch((error) => log.error(`[cleanup] 실패: ${error?.code ?? ''} ${error?.message ?? error}`));
  }, CLEANUP_INTERVAL_MS);
  return () => timers.clearInterval(handle);
}
