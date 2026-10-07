// T18 (D14, D17): write-behind saving, restoring after a restart, the clean-up job, and no
// student name anywhere in the jigsaw tables. Local Supabase only.
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createRegistry } from '../../../server/src/engine/registry.js';
import { createDbClient } from '../../../server/src/db.js';
import { BATCH_MS, createPersistence, installShutdown } from '../../../server/src/store/persistence.js';
import { runCleanup } from '../../../server/src/store/cleanup.js';
import { restoreOpenSessions } from '../../../server/src/store/restore.js';
import { TEACHERS, cleanup, sql } from './helpers.js';

const NAMES = ['홍길동저장시험', 'Zq7Probe', '김민준저장시험'];
const DAY = 24 * 60 * 60 * 1000;

let db;
const created = new Set();

// Timers the test fires by hand.
function manualTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimeout(fn, ms) {
      n += 1;
      pending.set(n, { fn, ms });
      return n;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    get delays() {
      return [...pending.values()].map((p) => p.ms);
    },
    fire() {
      const all = [...pending.values()];
      pending.clear();
      for (const p of all) p.fn();
    },
  };
}

const quietLog = () => {
  const lines = [];
  return { lines, error: (line) => lines.push(line), info: () => {} };
};

function makeRegistry(now = Date.now) {
  return createRegistry({ now });
}

function playingClass(registry, teacherId = TEACHERS.one.id) {
  const { result } = registry.createSession(teacherId, {
    pieceCount: 12,
    groupCount: 3,
    picture: { builtinKey: 'sea', aspect: 1999 / 1123 },
  });
  const session = registry.session(result.sessionId);
  created.add(session.id);
  const students = NAMES.map((name) => registry.join(session.code, { name }).result);
  session.assign(students[0].memberId, 1);
  session.assign(students[1].memberId, 1);
  session.assign(students[2].memberId, 2);
  for (const s of students) session.memberOnline(s.memberId);
  session.start();
  return { session, students };
}

const trayOf = (session, group, memberId) => session.toRecord().groups[group - 1].board.trays[memberId];
const boardRow = async (sessionId, number) =>
  (await sql('select board, completed_at from jigsaw.groups where session_id = $1 and number = $2', [sessionId, number])).rows[0];

beforeAll(() => {
  const env = inject('supabase');
  db = createDbClient({ url: env.url, serviceRoleKey: env.serviceKey });
});

afterAll(async () => {
  if (created.size) await sql('delete from jigsaw.sessions where id = any($1::uuid[])', [[...created]]);
  await cleanup();
});

describe('저장과 복구 (D17)', () => {
  it('저장한 뒤 새 엔진으로 복구하면 판·상자·배정이 같다', async () => {
    const registry = makeRegistry();
    const { session, students } = playingClass(registry);
    const a = students[0].memberId;
    session.puzzle(a, 'takeFromTray', trayOf(session, 1, a)[0], 12.345678901234567, 99.5);
    const persistence = createPersistence({ db, log: quietLog() });
    expect(await persistence.saveSession(session)).toBe(true);

    const restarted = makeRegistry();
    const records = (await persistence.loadOpenSessions()).filter((r) => r.id === session.id);
    expect(records).toHaveLength(1);
    const back = restarted.restore(records[0]);
    expect(back.toRecord()).toEqual(session.toRecord());
    expect(restarted.byToken(students[1].token)).toMatchObject({ memberId: students[1].memberId });
  });

  it('판 변경은 모둠별로 2초 묶음으로 한 번 저장된다', async () => {
    const registry = makeRegistry();
    const { session, students } = playingClass(registry);
    const timers = manualTimers();
    const persistence = createPersistence({ db, log: quietLog(), timers });
    await persistence.saveSession(session);
    const a = students[0].memberId;
    const before = (await boardRow(session.id, 1)).board;

    for (const piece of trayOf(session, 1, a).slice(0, 3)) {
      const { events } = session.puzzle(a, 'takeFromTray', piece, 0, 0);
      await persistence.persistEvents(session, events);
    }
    expect(timers.delays).toEqual([BATCH_MS]);
    expect((await boardRow(session.id, 1)).board).toEqual(before);

    timers.fire();
    await persistence.flush();
    const after = (await boardRow(session.id, 1)).board;
    expect(after).toEqual(session.toRecord().groups[0].board);
    expect(after.clusters.length).toBeGreaterThan(0);
  });

  it('저장이 실패하면 로그를 남기고 다음에 다시 저장한다 (로그에 행 내용은 없다)', async () => {
    const registry = makeRegistry();
    const { session, students } = playingClass(registry);
    const log = quietLog();
    const timers = manualTimers();
    let failures = 1;
    const flaky = {
      from(table) {
        if (table === 'groups' && failures > 0) {
          failures -= 1;
          return { upsert: async () => ({ error: { code: 'XX000', message: 'probe failure' } }) };
        }
        return db.from(table);
      },
    };
    const persistence = createPersistence({ db: flaky, log, timers });
    await createPersistence({ db, log }).saveSession(session);
    const a = students[0].memberId;
    const { events } = session.puzzle(a, 'takeFromTray', trayOf(session, 1, a)[0], 5, 5);
    await persistence.persistEvents(session, events);
    timers.fire();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('probe failure');
    for (const name of NAMES) expect(log.lines[0]).not.toContain(name);
    expect(timers.delays).toEqual([BATCH_MS]);
    timers.fire();
    await persistence.flush();
    expect((await boardRow(session.id, 1)).board).toEqual(session.toRecord().groups[0].board);
  });

  it('SIGTERM 을 받으면 남은 저장을 마친 뒤 끝난다', async () => {
    const registry = makeRegistry();
    const { session, students } = playingClass(registry);
    const persistence = createPersistence({ db, log: quietLog(), timers: manualTimers() });
    await persistence.saveSession(session);
    const a = students[0].memberId;
    const { events } = session.puzzle(a, 'takeFromTray', trayOf(session, 1, a)[0], 7, 7);
    await persistence.persistEvents(session, events);

    const proc = new EventEmitter();
    const exited = new Promise((resolve) => {
      proc.exit = resolve;
    });
    installShutdown(persistence, { proc, log: quietLog() });
    proc.emit('SIGTERM');
    expect(await exited).toBe(0);
    expect((await boardRow(session.id, 1)).board).toEqual(session.toRecord().groups[0].board);
  });

  it('끝내기·편성 같은 수업 이벤트는 바로 저장되고, 끝낸 수업의 members 행은 지워진다', async () => {
    const registry = makeRegistry();
    const { session } = playingClass(registry);
    const persistence = createPersistence({ db, log: quietLog(), timers: manualTimers() });
    await persistence.saveSession(session);
    expect((await sql('select count(*)::int as n from jigsaw.members where session_id = $1', [session.id])).rows[0].n).toBe(3);
    const { events } = registry.end(session.id);
    await persistence.persistEvents(session, events);
    const { rows } = await sql('select status, ended_at from jigsaw.sessions where id = $1', [session.id]);
    expect(rows[0].status).toBe('ended');
    expect((await sql('select count(*)::int as n from jigsaw.members where session_id = $1', [session.id])).rows[0].n).toBe(0);
    expect((await persistence.loadOpenSessions()).some((r) => r.id === session.id)).toBe(false);
  });
});

describe('정리 작업 (D14)', () => {
  it('24시간 지난 열린 수업을 닫고, 끝난 수업의 members 와 30일 지난 수업을 지운다', async () => {
    let t = Date.now();
    const clock = () => t;
    const registry = makeRegistry(clock);
    const persistence = createPersistence({ db, log: quietLog(), now: clock });
    const usersBefore = (await sql('select count(*)::int as n from auth.users')).rows[0].n;

    // In memory, started now; closes after 24 hours of the fake clock.
    const { session: live, students } = playingClass(registry);
    await persistence.saveSession(live);
    // Saved by an earlier process, not in memory, created 25 hours ago.
    const { session: orphan } = playingClass(makeRegistry());
    await persistence.saveSession(orphan);
    await sql(
      "update jigsaw.sessions set created_at = now() - interval '25 hours', started_at = now() - interval '25 hours' where id = $1",
      [orphan.id],
    );
    // Ended 31 and 29 days ago; the 29-day one still has members rows.
    const old = playingClass(makeRegistry()).session;
    const recent = playingClass(makeRegistry()).session;
    await persistence.saveSession(old);
    await persistence.saveSession(recent);
    await sql("update jigsaw.sessions set status = 'ended', ended_at = now() - interval '31 days' where id = $1", [old.id]);
    await sql("update jigsaw.sessions set status = 'ended', ended_at = now() - interval '29 days' where id = $1", [recent.id]);

    const first = await runCleanup({ registry, persistence, db, now: clock });
    expect(first.deletedSessions).toBeGreaterThanOrEqual(1);
    const status = async (id) => (await sql('select status from jigsaw.sessions where id = $1', [id])).rows[0]?.status;
    expect(await status(old.id)).toBeUndefined();
    expect(await status(recent.id)).toBe('ended');
    expect(await status(orphan.id)).toBe('ended');
    expect(await status(live.id)).toBe('playing');
    const members = async (id) => (await sql('select count(*)::int as n from jigsaw.members where session_id = $1', [id])).rows[0].n;
    expect(await members(recent.id)).toBe(0);
    expect(await members(orphan.id)).toBe(0);
    expect(await members(live.id)).toBe(3);

    t += DAY;
    const closedEvents = [];
    await runCleanup({ registry, persistence, db, now: clock, onClosed: (c) => closedEvents.push(c.events) });
    expect(closedEvents).toEqual([[{ to: 'session', type: 'end' }]]);
    expect(await status(live.id)).toBe('ended');
    expect(await members(live.id)).toBe(0);
    expect(registry.byToken(students[0].token)).toBeNull();

    expect((await sql('select count(*)::int as n from auth.users')).rows[0].n).toBe(usersBefore);
  });
});

describe('학생 이름은 DB 에 없다 (D14)', () => {
  it('jigsaw 스키마 전체 데이터에 시험 학생 이름 문자열이 없다', async () => {
    const registry = makeRegistry();
    const { session } = playingClass(registry);
    const persistence = createPersistence({ db, log: quietLog() });
    await persistence.saveSession(session);
    expect(session.roster().map((m) => m.name)).toEqual(NAMES);
    const { rows: tables } = await sql("select tablename from pg_tables where schemaname = 'jigsaw'");
    let dump = '';
    for (const { tablename } of tables) {
      const { rows } = await sql(`select coalesce(json_agg(t)::text, '') as text from jigsaw.${tablename} t`);
      dump += rows[0].text;
    }
    expect(dump).toContain(session.id);
    for (const name of NAMES) expect(dump).not.toContain(name);
  });
});

describe('T19 보강', () => {
  it('정리 작업은 끝난 수업을 나눠 읽고 members 를 조금씩 지운다 (행 수 제한 회피)', async () => {
    const persistence = createPersistence({ db, log: quietLog() });
    const ended = [];
    for (let i = 0; i < 3; i++) {
      const { session } = playingClass(makeRegistry());
      await persistence.saveSession(session);
      ended.push(session.id);
    }
    await sql("update jigsaw.sessions set status = 'ended', ended_at = now() where id = any($1::uuid[])", [ended]);
    const result = await runCleanup({ registry: makeRegistry(), persistence, db, pageSize: 2, chunkSize: 1 });
    expect(result.deletedMembers).toBeGreaterThanOrEqual(9);
    const { rows } = await sql('select count(*)::int as n from jigsaw.members where session_id = any($1::uuid[])', [ended]);
    expect(rows[0].n).toBe(0);
  });

  it('서버 시작 때 복구에 실패한 열린 수업은 바로 끝난 상태로 닫는다', async () => {
    const persistence = createPersistence({ db, log: quietLog() });
    const { session: good } = playingClass(makeRegistry());
    const { session: bad } = playingClass(makeRegistry());
    await persistence.saveSession(good);
    await persistence.saveSession(bad);
    // A piece in two places: not restorable.
    await sql(
      `update jigsaw.groups set board = jsonb_set(board, '{unowned}', '[0]'::jsonb)
       where session_id = $1 and number = 1`,
      [bad.id],
    );
    const registry = makeRegistry();
    const log = quietLog();
    const result = await restoreOpenSessions({ registry, persistence, db, log });
    expect(result.failed).toContain(bad.id);
    expect(result.failed).not.toContain(good.id);
    expect(registry.session(good.id)).not.toBeNull();
    expect(registry.session(bad.id)).toBeNull();
    const { rows } = await sql('select status, ended_at from jigsaw.sessions where id = $1', [bad.id]);
    expect(rows[0].status).toBe('ended');
    expect(rows[0].ended_at).not.toBeNull();
    expect(log.lines.join('\n')).toContain(bad.id);
    // Close the good one too so later runs do not restore it.
    await sql("update jigsaw.sessions set status = 'ended', ended_at = now() where id = $1", [good.id]);
  });

  it('SIGTERM 때 새 요청을 막는 단계가 저장보다 먼저 돈다', async () => {
    const order = [];
    const persistence = { flush: async () => order.push('flush') && true };
    const proc = new EventEmitter();
    const exited = new Promise((resolve) => {
      proc.exit = resolve;
    });
    installShutdown(persistence, { proc, log: quietLog(), beforeFlush: async () => order.push('close') });
    proc.emit('SIGTERM');
    expect(await exited).toBe(0);
    expect(order).toEqual(['close', 'flush']);
  });
});
