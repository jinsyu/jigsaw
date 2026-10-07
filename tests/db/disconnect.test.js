// T6: disconnect handling — heartbeat, holds that lapse (D8) and redistribution of the
// trays of students gone for over a minute (D9). Time is simulated by moving last_seen /
// grabbed_at into the past.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEACHERS,
  beginAsStudent,
  cleanup,
  dbClient,
  deleteSessions,
  leaveAllChannels,
  rpcOk,
  sleep,
  sql,
  studentClient,
  subscribe,
  teacherClient,
  waitFor,
  warmUp,
} from './helpers.js';

const FORBIDDEN = '42501';
const DEADLOCK = '40P01';
// Far from the frame origin (about (82.8, 62.1) for 4x3) so nothing locks by accident.
const FAR = { x: 300, y: 250 };

let teacher;
const sessionIds = [];

beforeAll(async () => {
  teacher = await teacherClient(TEACHERS.one);
});

afterEach(leaveAllChannels);

afterAll(async () => {
  await deleteSessions(sessionIds);
  await cleanup();
});

async function openSession({ pieceCount = 12, groups = 1 } = {}) {
  const session = await rpcOk(teacher.client, 'create_session', {
    p_piece_count: pieceCount,
    p_group_count: groups,
    p_builtin_key: 'test-scene',
    p_aspect: 4 / 3,
  });
  sessionIds.push(session.id);
  const { rows } = await sql('select id from public.groups where session_id = $1 order by number', [session.id]);
  return { session, groupIds: rows.map((r) => Number(r.id)) };
}

async function joinInto(session, groupId) {
  const student = await studentClient();
  const joined = await rpcOk(student.client, 'join_session', { p_code: session.code });
  student.memberId = joined.member_id;
  await rpcOk(teacher.client, 'assign_member', { p_member: joined.member_id, p_group: groupId });
  return student;
}

// A playing session with `count` students in group 1 (trays dealt by start_session).
async function playing({ count = 2, groups = 1, pieceCount = 12, start = true } = {}) {
  const { session, groupIds } = await openSession({ pieceCount, groups });
  const students = [];
  for (let i = 0; i < count; i += 1) students.push(await joinInto(session, groupIds[0]));
  if (start) await rpcOk(teacher.client, 'start_session', { p_session: session.id });
  return { session, groupId: groupIds[0], groupIds, students };
}

// Last signal `seconds` ago (0 = now).
async function lastSeen(student, seconds) {
  await sql(`update public.members set last_seen = now() - make_interval(secs => $2) where user_id = $1`, [
    student.userId,
    seconds,
  ]);
}

async function lastSeenOf(student) {
  const { rows } = await sql(
    'select extract(epoch from now() - last_seen)::float8 as age from public.members where user_id = $1',
    [student.userId],
  );
  return rows[0].age;
}

async function trayCounts(groupId) {
  const { rows } = await sql(
    `select owner_id, count(*)::int as n from public.pieces
     where group_id = $1 and not on_board group by owner_id`,
    [groupId],
  );
  return Object.fromEntries(rows.map((r) => [r.owner_id, r.n]));
}

async function trayOf(groupId, student) {
  const { rows } = await sql(
    `select col, "row" from public.pieces where group_id = $1 and owner_id = $2 and not on_board
     order by "row", col`,
    [groupId, student.userId],
  );
  return rows.map((r) => [r.col, r.row]);
}

// Puts one of the student's tray pieces on the board, far apart from the others.
async function placeOne(groupId, student, offset = 0) {
  const { rows } = await sql(
    `select p."row" * s.cols + p.col as piece from public.pieces p
     join public.groups g on g.id = p.group_id join public.sessions s on s.id = g.session_id
     where p.group_id = $1 and p.owner_id = $2 and not p.on_board order by p."row", p.col limit 1`,
    [groupId, student.userId],
  );
  const result = await rpcOk(student.client, 'take_from_tray', {
    p_group: groupId,
    p_piece: rows[0].piece,
    p_x: FAR.x + offset,
    p_y: FAR.y + offset,
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.id;
}

const grab = (student, clusterId) => student.client.rpc('grab', { p_cluster: clusterId }).then((r) => r.data);
const heartbeat = (student) => rpcOk(student.client, 'heartbeat');
const redistribute = (student, groupId) =>
  student.client.rpc('redistribute_stale', { p_group: groupId }).then(({ data, error }) => {
    if (error) throw new Error(`redistribute_stale: ${error.code} ${error.message}`);
    return data;
  });

describe('heartbeat', () => {
  it('내 last_seen 만 지금으로 바꾸고, 기다리는 중에도 되며, 수업에 없으면 not_found·교사는 거부', async () => {
    const { session, students } = await playing({ count: 2, start: false });
    const [a, b] = students;
    await lastSeen(a, 3600);
    await lastSeen(b, 3600);

    const result = await heartbeat(a);
    expect(result.ok).toBe(true);
    expect(Math.abs(Date.parse(result.last_seen) - Date.now())).toBeLessThan(5000);
    expect(await lastSeenOf(a)).toBeLessThan(5);
    expect(await lastSeenOf(b)).toBeGreaterThan(3500);
    expect(Object.keys(result).sort()).toEqual(['last_seen', 'ok']);

    const outsider = await studentClient();
    expect(await heartbeat(outsider)).toEqual({ ok: false, reason: 'not_found' });
    expect((await teacher.client.rpc('heartbeat')).error).toMatchObject({ code: FORBIDDEN });

    await rpcOk(teacher.client, 'start_session', { p_session: session.id });
    expect((await heartbeat(b)).ok).toBe(true);
    await rpcOk(teacher.client, 'end_session', { p_session: session.id });
    // The account is gone but the JWT still works until it expires.
    expect(await heartbeat(b)).toEqual({ ok: false, reason: 'not_found' });
    const { rows } = await sql('select count(*)::int as n from public.members where session_id = $1', [session.id]);
    expect(rows[0].n).toBe(0);
  });

  it('알려진 한계 해소: 입장하고 15초가 지나도 heartbeat 를 보내는 학생의 잡기는 뺏기지 않는다', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    const first = await placeOne(groupId, a, 0);
    const second = await placeOne(groupId, a, 200);

    // Joined 20 seconds ago and no signal since: the state every student was in before T6.
    await lastSeen(a, 20);
    await lastSeen(b, 20);
    expect((await grab(a, first)).ok).toBe(true);
    expect((await grab(b, first)).ok).toBe(true); // the hold did not protect anything

    // The screen sends heartbeat every 5 seconds: three rounds of "20 seconds later".
    for (let round = 0; round < 3; round += 1) {
      await lastSeen(a, 20);
      await heartbeat(a);
      expect((await grab(a, second)).ok).toBe(true);
      expect(await grab(b, second)).toEqual({ ok: false, reason: 'held', held_by: a.userId });
    }

    // a stops sending: 16 seconds later b may take it even though a grabbed it just now.
    await lastSeen(a, 16);
    expect((await grab(b, second)).ok).toBe(true);
  });

  it('D8: 잡은 지 10초가 지나면 접속 중이어도, 잡은 사람이 끊기면 10초 전이라도 다른 학생이 잡는다', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    const id = await placeOne(groupId, a);
    const grabbedAgo = (seconds) =>
      sql('update public.clusters set grabbed_at = now() - make_interval(secs => $2) where id = $1', [id, seconds]);

    await heartbeat(a);
    await heartbeat(b);
    expect((await grab(a, id)).ok).toBe(true);
    await grabbedAgo(9);
    expect(await grab(b, id)).toMatchObject({ ok: false, reason: 'held' });
    await grabbedAgo(11);
    expect((await grab(b, id)).ok).toBe(true);

    // b holds it now (grabbed just now). Connected = last signal at most 15 seconds ago.
    await lastSeen(b, 13);
    expect(await grab(a, id)).toEqual({ ok: false, reason: 'held', held_by: b.userId });
    await lastSeen(b, 17);
    expect((await grab(a, id)).ok).toBe(true);

    // Taken over: the old holder can no longer drop it, the new one can.
    expect((await b.client.rpc('drop', { p_cluster: id, p_x: 10, p_y: 10 })).data).toEqual({
      ok: false,
      reason: 'not_held',
    });
    expect((await rpcOk(a.client, 'drop', { p_cluster: id, p_x: 200, p_y: 150 })).ok).toBe(true);
  });
});

describe('redistribute_stale', () => {
  it('1분 넘게 끊긴 학생의 상자 조각을 접속자(시작 뒤 들어온 학생 포함)에게 고르게 나누고 방송한다', async () => {
    const { session, groupId, students } = await playing({ count: 3, pieceCount: 24 });
    const [gone, online, away] = students;
    const late = await joinInto(session, groupId); // assigned after start: no tray
    expect(await trayCounts(groupId)).toEqual({ [gone.userId]: 8, [online.userId]: 8, [away.userId]: 8 });
    await placeOne(groupId, gone); // one of gone's pieces is already on the board
    const goneTray = await trayOf(groupId, gone);
    expect(goneTray).toHaveLength(7);

    const watcher = await subscribe(late.client, `group:${groupId}`);
    expect(watcher.status).toBe('SUBSCRIBED');
    await warmUp(watcher, `group:${groupId}`);

    await lastSeen(gone, 120);
    await lastSeen(away, 30); // not connected, but not gone for a minute: keeps the tray, gets nothing
    await heartbeat(online);
    await heartbeat(late);

    const result = await redistribute(online, groupId);
    expect(result.ok).toBe(true);
    expect(result.pieces.map((p) => [p.col, p.row]).sort()).toEqual([...goneTray].sort());
    const dealt = { [online.userId]: 0, [late.userId]: 0 };
    for (const p of result.pieces) dealt[p.owner] += 1;
    expect(Object.values(dealt).sort()).toEqual([3, 4]);

    const after = await trayCounts(groupId);
    expect(after[gone.userId]).toBeUndefined();
    expect(after[away.userId]).toBe(8);
    expect(after[online.userId]).toBe(8 + dealt[online.userId]);
    expect(after[late.userId]).toBe(dealt[late.userId]);
    const { rows: board } = await sql(
      'select count(*)::int as n from public.pieces where group_id = $1 and on_board and owner_id is null',
      [groupId],
    );
    expect(board[0].n).toBe(1);

    expect(await waitFor(() => watcher.received.some((m) => m.event === 'tray'))).toBe(true);
    const sent = watcher.received.filter((m) => m.event === 'tray');
    expect(sent).toHaveLength(1);
    // Realtime adds its own message id (uuid) to every payload.
    const { id: messageId, ...payload } = sent[0].payload;
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload).toEqual({ pieces: result.pieces });
    // Only cells and uids: no names or other personal data in the broadcast.
    for (const p of sent[0].payload.pieces) expect(Object.keys(p).sort()).toEqual(['col', 'owner', 'row']);
  });

  it('여러 화면이 동시에·거듭 불러도 한 번만 나눈다(멱등)', async () => {
    const { groupId, students } = await playing({ count: 3 });
    const [gone, b, c] = students;
    const watcher = await subscribe(teacher.client, `group:${groupId}`);
    await warmUp(watcher, `group:${groupId}`);
    await lastSeen(gone, 90);
    await heartbeat(b);
    await heartbeat(c);

    const results = await Promise.all([b, c, b, c, b].map((s) => redistribute(s, groupId)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.pieces.length).sort()).toEqual([0, 0, 0, 0, 4]);
    expect(await redistribute(b, groupId)).toEqual({ ok: true, pieces: [] });

    const counts = await trayCounts(groupId);
    expect(counts[gone.userId]).toBeUndefined();
    expect(counts[b.userId] + counts[c.userId]).toBe(12);
    expect(Math.abs(counts[b.userId] - counts[c.userId])).toBeLessThanOrEqual(1);

    await sleep(800);
    expect(watcher.received.filter((m) => m.event === 'tray')).toHaveLength(1);
  });

  it('1분 안에 같은 uid 로 돌아오면 상자가 그대로이고, 돌아온 뒤에는 다시 1분을 센다', async () => {
    const { session, groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await heartbeat(b);
    const before = await trayOf(groupId, a);
    expect(before).toHaveLength(6);

    await lastSeen(a, 50);
    expect(await redistribute(b, groupId)).toEqual({ ok: true, pieces: [] });

    // The same device opens the page again: same account, same members row, same group.
    const again = await rpcOk(a.client, 'join_session', { p_code: session.code });
    expect(again).toMatchObject({ ok: true, member_id: a.memberId, group_id: groupId, status: 'playing' });
    expect(await lastSeenOf(a)).toBeLessThan(5);
    await heartbeat(a);
    await lastSeen(a, 50);
    expect(await redistribute(b, groupId)).toEqual({ ok: true, pieces: [] });
    expect(await trayOf(groupId, a)).toEqual(before);

    // Gone for good this time.
    await lastSeen(a, 70);
    expect((await redistribute(b, groupId)).pieces).toHaveLength(6);
    expect(await trayOf(groupId, a)).toEqual([]);
  });

  it('접속자가 아무도 없으면 나누지 않고 방송도 없다', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [gone, caller] = students;
    const watcher = await subscribe(teacher.client, `group:${groupId}`);
    await warmUp(watcher, `group:${groupId}`);
    await lastSeen(gone, 300);
    await lastSeen(caller, 30); // the caller's own screen missed its heartbeats too
    const before = await trayCounts(groupId);

    expect(await redistribute(caller, groupId)).toEqual({ ok: true, pieces: [] });
    expect(await trayCounts(groupId)).toEqual(before);
    await sleep(800);
    expect(watcher.received.filter((m) => m.event === 'tray')).toHaveLength(0);

    await heartbeat(caller);
    expect((await redistribute(caller, groupId)).pieces).toHaveLength(6);
    expect(await trayCounts(groupId)).toEqual({ [caller.userId]: 12 });
  });

  it('다른 모둠·모둠 없는 학생은 not_found, 교사는 거부, 시작 전에는 not_playing', async () => {
    const { session, groupIds, students } = await playing({ count: 1, groups: 2 });
    const [a] = students;
    expect(await redistribute(a, groupIds[1])).toEqual({ ok: false, reason: 'not_found' });
    expect(await redistribute(a, null)).toEqual({ ok: false, reason: 'not_found' });
    const loose = await studentClient();
    await rpcOk(loose.client, 'join_session', { p_code: session.code });
    expect(await redistribute(loose, groupIds[0])).toEqual({ ok: false, reason: 'not_found' });
    const byTeacher = await teacher.client.rpc('redistribute_stale', { p_group: groupIds[0] });
    expect(byTeacher.error).toMatchObject({ code: FORBIDDEN });

    const waiting = await playing({ count: 1, start: false });
    expect(await redistribute(waiting.students[0], waiting.groupId)).toEqual({ ok: false, reason: 'not_playing' });
  });
});

describe('동시성: 잠금 순서와 경쟁', () => {
  it('redistribute_stale 은 모둠 행부터 잠그고, 그동안 덩어리·학생·조각 행은 잡지 않는다', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [gone, b] = students;
    const clusterId = await placeOne(groupId, b);
    await lastSeen(gone, 120);
    await heartbeat(b);

    const holder = await dbClient();
    await holder.query('begin');
    await holder.query('select 1 from public.groups where id = $1 for update', [groupId]);
    let finished = false;
    const pending = redistribute(b, groupId).then((value) => {
      finished = true;
      return value;
    });
    await sleep(400);
    expect(finished).toBe(false);

    const probe = await dbClient();
    await probe.query('begin');
    const nowait = (text, params) => probe.query(text, params).then(() => true, (error) => error.code);
    expect(await nowait('select 1 from public.clusters where id = $1 for update nowait', [clusterId])).toBe(true);
    expect(await nowait('select 1 from public.members where user_id = $1 for update nowait', [gone.userId])).toBe(true);
    expect(
      await nowait('select 1 from public.pieces where owner_id = $1 for update nowait', [gone.userId]),
    ).toBe(true);
    await probe.query('rollback');
    await holder.query('commit');
    expect((await pending).pieces).toHaveLength(6);
  });

  it('나누기 직전에 도착한 heartbeat 가 먼저 끝나면 나누지 않는다(반쯤 나뉘지 않음)', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await lastSeen(a, 120);
    await heartbeat(b);
    const before = await trayOf(groupId, a);

    // a's heartbeat is in flight (transaction open) when b's screen asks to redistribute.
    const conn = await dbClient();
    await beginAsStudent(conn, a.userId);
    const { rows } = await conn.query('select public.heartbeat() as r');
    expect(rows[0].r.ok).toBe(true);
    let finished = false;
    const pending = redistribute(b, groupId).then((value) => {
      finished = true;
      return value;
    });
    await sleep(400);
    expect(finished).toBe(false); // waits for a's members row
    await conn.query('commit');
    expect(await pending).toEqual({ ok: true, pieces: [] });
    expect(await trayOf(groupId, a)).toEqual(before);
  });

  it('나누는 중에 온 heartbeat 는 나누기가 끝난 뒤에 반영된다(돌아와도 상자는 이미 나뉨)', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await lastSeen(a, 120);
    await heartbeat(b);

    const conn = await dbClient();
    await beginAsStudent(conn, b.userId);
    const { rows } = await conn.query('select public.redistribute_stale($1) as r', [groupId]);
    expect(rows[0].r.pieces).toHaveLength(6);
    let finished = false;
    const pending = heartbeat(a).then((value) => {
      finished = true;
      return value;
    });
    await sleep(400);
    expect(finished).toBe(false);
    await conn.query('commit');
    expect((await pending).ok).toBe(true);
    expect(await trayOf(groupId, a)).toEqual([]);
    expect(await lastSeenOf(a)).toBeLessThan(5);
    expect(await trayCounts(groupId)).toEqual({ [b.userId]: 12 });
  });

});

// private.lock_board fix: a call that waited for end_session's locks must see the session as
// ended. Before the fix it saw 'playing' from the snapshot taken before the wait and was
// refused for a side effect of end_session instead (drop: not_held, take: not_in_tray).
describe('수업 끝내기를 기다린 호출은 not_playing (lock_board 가 잠금 뒤 상태를 다시 읽음)', () => {
  // Runs end_session in an open transaction as the teacher, starts `call` (which must block
  // on the group row) and commits; resolves with the call's result.
  async function afterPendingEnd(sessionId, call) {
    const conn = await dbClient();
    await conn.query('begin');
    await conn.query('set local role authenticated');
    await conn.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: TEACHERS.one.id, role: 'authenticated', is_anonymous: false }),
    ]);
    await conn.query('select public.end_session($1)', [sessionId]);
    let finished = false;
    const pending = call().then((value) => {
      finished = true;
      return value;
    });
    await sleep(400);
    expect(finished).toBe(false);
    await conn.query('commit');
    return pending;
  }

  it('나누기', async () => {
    const { session, groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await lastSeen(a, 120);
    await heartbeat(b);
    expect(await afterPendingEnd(session.id, () => redistribute(b, groupId))).toEqual({
      ok: false,
      reason: 'not_playing',
    });
  });

  it('놓기', async () => {
    const { session, groupId, students } = await playing({ count: 2 });
    const [a] = students;
    const id = await placeOne(groupId, a);
    await rpcOk(a.client, 'grab', { p_cluster: id });
    const result = await afterPendingEnd(session.id, () =>
      a.client.rpc('drop', { p_cluster: id, p_x: 200, p_y: 150 }).then((r) => r.data),
    );
    expect(result).toEqual({ ok: false, reason: 'not_playing' });
  });

  it('상자에서 꺼내기', async () => {
    const { session, groupId, students } = await playing({ count: 2 });
    const [a] = students;
    const [cell] = await trayOf(groupId, a);
    const result = await afterPendingEnd(session.id, () =>
      a.client
        .rpc('take_from_tray', { p_group: groupId, p_piece: cell[1] * 4 + cell[0], p_x: FAR.x, p_y: FAR.y })
        .then((r) => r.data),
    );
    expect(result).toEqual({ ok: false, reason: 'not_playing' });
    const { rows } = await sql('select on_board from public.pieces where group_id = $1 and col = $2 and "row" = $3', [
      groupId,
      cell[0],
      cell[1],
    ]);
    expect(rows[0].on_board).toBe(false);
  });
});

describe('동시성: 여러 호출', () => {

  it('놓기·꺼내기·모둠 옮기기·heartbeat·나누기를 동시에 여러 번 불러도 교착 없이 끝난다', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { groupIds, students } = await playing({ count: 4, groups: 2 });
      const [gone, a, b, mover] = students;
      const [g1] = groupIds;
      await lastSeen(gone, 120);
      for (const s of [a, b, mover]) await heartbeat(s);
      const held = await placeOne(g1, a, 0);
      const moverHeld = await placeOne(g1, mover, 150);
      await rpcOk(a.client, 'grab', { p_cluster: held });
      await rpcOk(mover.client, 'grab', { p_cluster: moverHeld });
      const { rows } = await sql(
        `select "row" * 4 + col as piece from public.pieces
         where group_id = $1 and owner_id = $2 and not on_board limit 1`,
        [g1, b.userId],
      );

      const calls = [
        a.client.rpc('drop', { p_cluster: held, p_x: FAR.x - 50, p_y: FAR.y - 50 }),
        b.client.rpc('take_from_tray', { p_group: g1, p_piece: rows[0].piece, p_x: 10, p_y: 10 }),
        teacher.client.rpc('assign_member', { p_member: mover.memberId, p_group: groupIds[1] }),
        gone.client.rpc('heartbeat'),
        a.client.rpc('redistribute_stale', { p_group: g1 }),
        b.client.rpc('redistribute_stale', { p_group: g1 }),
        mover.client.rpc('heartbeat'),
      ];
      const results = await Promise.all(calls);
      for (const { error } of results) {
        expect(error?.code, JSON.stringify(error)).not.toBe(DEADLOCK);
        expect(error, JSON.stringify(error)).toBeNull();
      }
      // Every tray piece still has exactly one owner, and no board piece has one.
      const { rows: check } = await sql(
        `select count(*) filter (where on_board and owner_id is not null)::int as board_owned,
                count(*) filter (where not on_board and owner_id is null)::int as orphaned
         from public.pieces where group_id = $1`,
        [g1],
      );
      expect(check[0]).toEqual({ board_owned: 0, orphaned: 0 });
    }
  });
});

describe('권한', () => {
  it('anon 은 heartbeat·redistribute_stale 를 실행할 수 없고, private.stale_since 는 API 역할에 닫혀 있다', async () => {
    const { rows } = await sql(
      `select has_function_privilege('anon', 'public.heartbeat()', 'execute') as anon_hb,
              has_function_privilege('anon', 'public.redistribute_stale(bigint)', 'execute') as anon_rs,
              has_function_privilege('authenticated', 'public.heartbeat()', 'execute') as auth_hb,
              has_function_privilege('authenticated', 'public.redistribute_stale(bigint)', 'execute') as auth_rs,
              has_function_privilege('authenticated', 'private.stale_since()', 'execute') as auth_stale`,
    );
    expect(rows[0]).toEqual({ anon_hb: false, anon_rs: false, auth_hb: true, auth_rs: true, auth_stale: false });
  });
});
