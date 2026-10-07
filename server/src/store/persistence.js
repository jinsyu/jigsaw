// Saving the engine's state to jigsaw.* (write-behind) and reading it back after a restart.
//
// - saveSession(session): the whole class at once (session row, then group rows, then member
//   rows, members no longer in the class deleted). Used right away for creating, joining,
//   grouping, starting, completing and ending (persistEvents picks these).
// - scheduleBoard(session, group): board changes are saved per group at most every BATCH_MS.
// - A failed save is logged (code and message only, no row data) and tried again later.
// - Saves of one class run one after another, each reading the class state when it runs.
// - flush() saves everything still pending (SIGTERM, see installShutdown).
import { groupRow, memberRow, recordFromRows, sessionRow } from './records.js';

export const BATCH_MS = 2000;
const FLUSH_ROUNDS = 3;

// Board events that change what is saved in groups.board.
const BOARD_EVENTS = new Set(['take', 'drop', 'tray', 'leave']);
// Events after which the whole class is saved right away.
const CLASS_EVENTS = new Set(['join', 'groups', 'start', 'complete', 'end']);

/**
 * @param {object} options
 * @param {import('@supabase/supabase-js').SupabaseClient} options.db  createDbClient()
 * @param {{ error: Function, info?: Function }} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.batchMs]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
 */
export function createPersistence({
  db,
  log = console,
  now = Date.now,
  batchMs = BATCH_MS,
  timers = { setTimeout, clearTimeout },
}) {
  const pendingBoards = new Map(); // session id -> { session, groups: Set<number> }
  const pendingClasses = new Map(); // session id -> session (full save to retry)
  const queues = new Map(); // session id -> tail promise
  let timer = null;

  function enqueue(sessionId, job) {
    const tail = (queues.get(sessionId) ?? Promise.resolve()).then(job);
    const settled = tail.catch(() => {});
    queues.set(sessionId, settled);
    settled.then(() => {
      if (queues.get(sessionId) === settled) queues.delete(sessionId);
    });
    return tail;
  }

  function arm() {
    if (timer === null) timer = timers.setTimeout(onTimer, batchMs);
  }

  function onTimer() {
    timer = null;
    savePending();
  }

  function failed(what, error) {
    log.error(`[store] ${what} 저장 실패: ${error?.code ?? ''} ${error?.message ?? error}`);
  }

  async function check(promise) {
    const { error } = await promise;
    if (error) throw error;
  }

  async function writeClass(session) {
    const record = session.toRecord();
    const savedAt = now();
    await check(db.from('sessions').upsert(sessionRow(record), { onConflict: 'id' }));
    await check(
      db.from('groups').upsert(
        record.groups.map((g) => groupRow(record, g, savedAt)),
        { onConflict: 'session_id,number' },
      ),
    );
    if (record.members.length > 0) {
      await check(db.from('members').upsert(record.members.map((m) => memberRow(record, m)), { onConflict: 'id' }));
    }
    const stale = db.from('members').delete().eq('session_id', record.id);
    const keep = record.members.map((m) => m.id);
    await check(keep.length > 0 ? stale.not('id', 'in', `(${keep.join(',')})`) : stale);
  }

  async function writeBoards(session, numbers) {
    const record = session.toRecord();
    const savedAt = now();
    const rows = record.groups.filter((g) => numbers.has(g.number)).map((g) => groupRow(record, g, savedAt));
    if (rows.length > 0) await check(db.from('groups').upsert(rows, { onConflict: 'session_id,number' }));
  }

  // The whole class now. Resolves true when saved, false when it failed (kept for a retry).
  function saveSession(session) {
    pendingClasses.delete(session.id);
    pendingBoards.delete(session.id); // the full save includes every board
    return enqueue(session.id, () => writeClass(session)).then(
      () => true,
      (error) => {
        failed(`수업 ${session.id}`, error);
        pendingClasses.set(session.id, session);
        arm();
        return false;
      },
    );
  }

  function scheduleBoard(session, number) {
    const entry = pendingBoards.get(session.id) ?? { session, groups: new Set() };
    entry.groups.add(number);
    pendingBoards.set(session.id, entry);
    arm();
  }

  function saveBoards(session, numbers) {
    return enqueue(session.id, () => writeBoards(session, numbers)).then(
      () => true,
      (error) => {
        failed(`수업 ${session.id} 모둠 판`, error);
        for (const n of numbers) scheduleBoard(session, n);
        return false;
      },
    );
  }

  function savePending() {
    const classes = [...pendingClasses.values()];
    const boards = [...pendingBoards.values()].filter((b) => !pendingClasses.has(b.session.id));
    pendingClasses.clear();
    pendingBoards.clear();
    return Promise.all([...classes.map(saveSession), ...boards.map((b) => saveBoards(b.session, b.groups))]);
  }

  // Engine events -> what to save. Events of other kinds (grab, release, presence) change
  // nothing that is stored.
  function persistEvents(session, events) {
    if (events.some((e) => CLASS_EVENTS.has(e.type))) return saveSession(session);
    for (const e of events) if (e.to === 'group' && BOARD_EVENTS.has(e.type)) scheduleBoard(session, e.group);
    return Promise.resolve(true);
  }

  // Everything pending, now (and what is already being written). Resolves true when nothing
  // is left unsaved.
  async function flush() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    for (let round = 0; round < FLUSH_ROUNDS; round++) {
      await Promise.all(queues.values());
      if (pendingClasses.size === 0 && pendingBoards.size === 0) break;
      await savePending();
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    }
    await Promise.all(queues.values());
    return pendingClasses.size === 0 && pendingBoards.size === 0;
  }

  // Open classes (waiting or playing) as toRecord() objects, for registry.restore().
  async function loadOpenSessions() {
    // Open classes are capped (registry MAX_OPEN_SESSIONS = 100), well under the row limit.
    const { data: sessions, error } = await db.from('sessions').select('*').in('status', ['waiting', 'playing']);
    if (error) throw error;
    if (sessions.length === 0) return [];
    // One class at a time: at most 12 groups and 60 members each, under PostgREST's row limit.
    return Promise.all(
      sessions.map(async (s) => {
        const [groups, members] = await Promise.all([
          db.from('groups').select('*').eq('session_id', s.id),
          db.from('members').select('*').eq('session_id', s.id),
        ]);
        if (groups.error) throw groups.error;
        if (members.error) throw members.error;
        return recordFromRows(s, groups.data, members.data);
      }),
    );
  }

  return { saveSession, scheduleBoard, persistEvents, flush, loadOpenSessions };
}

// SIGTERM (systemd stop, deploy): stop taking requests (beforeFlush), finish the pending
// saves, then exit.
export function installShutdown(persistence, { proc = process, log = console, beforeFlush = async () => {} } = {}) {
  let stopping = false;
  proc.once('SIGTERM', async () => {
    if (stopping) return;
    stopping = true;
    await Promise.resolve()
      .then(beforeFlush)
      .catch((error) => log.error(`[server] 종료 준비 실패: ${error?.message ?? error}`));
    const done = await persistence.flush().catch((error) => {
      log.error(`[store] 종료 전 저장 실패: ${error?.message ?? error}`);
      return false;
    });
    proc.exit(done ? 0 : 1);
  });
}
