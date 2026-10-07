// T5: puzzle RPCs — take_from_tray, grab, drop (D5, D6, D7, D10) and the T4 review
// follow-ups (deal_tray race, assign_member vs take_from_tray).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { clampPosition, frameOrigin } from '../../public/js/puzzle/snap.js';
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

// A playing 4x3 session with one group (or more) and `count` students in group 1.
async function playing({ count = 2, groups = 1, start = true } = {}) {
  const session = await rpcOk(teacher.client, 'create_session', {
    p_piece_count: 12,
    p_group_count: groups,
    p_builtin_key: 'test-scene',
    p_aspect: 4 / 3,
  });
  sessionIds.push(session.id);
  const { rows } = await sql('select id from public.groups where session_id = $1 order by number', [session.id]);
  const groupIds = rows.map((r) => Number(r.id));
  const students = [];
  for (let i = 0; i < count; i += 1) {
    const student = await studentClient();
    const joined = await rpcOk(student.client, 'join_session', { p_code: session.code });
    student.memberId = joined.member_id;
    await rpcOk(teacher.client, 'assign_member', { p_member: joined.member_id, p_group: groupIds[0] });
    students.push(student);
  }
  if (start) await rpcOk(teacher.client, 'start_session', { p_session: session.id });
  const layout = layoutFor(session.cols, session.rows, session.aspect);
  return { session, groupId: groupIds[0], groupIds, students, layout };
}

const pieceOf = ([col, row]) => row * 4 + col;

// Puts the given cells into a student's tray (test setup only).
async function giveTray(groupId, userId, cells) {
  for (const [col, row] of cells) {
    await sql('update public.pieces set owner_id = $1 where group_id = $2 and col = $3 and "row" = $4', [
      userId,
      groupId,
      col,
      row,
    ]);
  }
}

async function pieceRow(groupId, [col, row]) {
  const { rows } = await sql(
    `select p.owner_id, p.on_board, c.id as cluster_id, c.x, c.y, c.locked, c.grabbed_by, c.grabbed_at
     from public.pieces p join public.clusters c on c.id = p.cluster_id
     where p.group_id = $1 and p.col = $2 and p."row" = $3`,
    [groupId, col, row],
  );
  return { ...rows[0], cluster_id: Number(rows[0].cluster_id) };
}

const take = (student, groupId, cell, x, y) =>
  student.client.rpc('take_from_tray', { p_group: groupId, p_piece: pieceOf(cell), p_x: x, p_y: y });

async function takeOk(student, groupId, cell, x, y) {
  const { data, error } = await take(student, groupId, cell, x, y);
  if (error) throw new Error(`take_from_tray: ${error.code} ${error.message}`);
  expect(data.ok, JSON.stringify(data)).toBe(true);
  return data;
}

async function touch(...students) {
  for (const s of students) {
    await sql('update public.members set last_seen = now() where user_id = $1', [s.userId]);
  }
}

describe('take_from_tray', () => {
  it('상자 주인만 꺼내고, 꺼낸 조각은 판 위에 놓인 채(잡지 않은 상태) 상자에서 빠진다', async () => {
    const { groupId, students } = await playing();
    const [a, b] = students;
    await giveTray(groupId, a.userId, [[0, 0], [3, 2]]);

    const result = await takeOk(a, groupId, [0, 0], FAR.x, FAR.y);
    expect(result).toMatchObject({
      ok: true,
      piece: 0,
      x: FAR.x,
      y: FAR.y,
      locked: false,
      absorbed: [],
      progress: { placed: 0, total: 12, complete: false },
      completed_at: null,
      completed_now: false,
    });
    expect(result.id).toBe(result.cluster_id);
    const row = await pieceRow(groupId, [0, 0]);
    expect(row).toMatchObject({ owner_id: null, on_board: true, cluster_id: result.cluster_id, grabbed_by: null });
    expect([row.x, row.y]).toEqual([FAR.x, FAR.y]);

    // Someone else's piece, the same piece again, and impossible indexes.
    expect((await take(b, groupId, [3, 2], FAR.x, FAR.y)).data).toEqual({ ok: false, reason: 'not_in_tray' });
    expect((await take(a, groupId, [0, 0], FAR.x, FAR.y)).data).toEqual({ ok: false, reason: 'not_in_tray' });
    for (const p_piece of [-1, 12, 99]) {
      const { data } = await a.client.rpc('take_from_tray', { p_group: groupId, p_piece, p_x: 0, p_y: 0 });
      expect(data).toEqual({ ok: false, reason: 'not_in_tray' });
    }
    expect((await pieceRow(groupId, [3, 2])).owner_id).toBe(a.userId);
  });

  it('x, y 가 NaN·Infinity·null 이면 bad_position 이고 조각은 상자에 남는다', async () => {
    const { groupId, students } = await playing({ count: 1 });
    const [a] = students;
    await giveTray(groupId, a.userId, [[1, 1]]);
    const bad = ['NaN', 'Infinity', '-Infinity', null];
    for (const value of bad) {
      for (const args of [{ p_x: value, p_y: 10 }, { p_x: 10, p_y: value }]) {
        const { data, error } = await a.client.rpc('take_from_tray', {
          p_group: groupId,
          p_piece: pieceOf([1, 1]),
          ...args,
        });
        expect(error, JSON.stringify(args)).toBeNull();
        expect(data, JSON.stringify(args)).toEqual({ ok: false, reason: 'bad_position' });
      }
    }
    expect(await pieceRow(groupId, [1, 1])).toMatchObject({ owner_id: a.userId, on_board: false });
  });

  it('놓기와 같은 판정: 판 밖이면 자르고, 이웃에 붙고, 틀 가까이면 제자리에 고정한다', async () => {
    const { groupId, students, layout } = await playing({ count: 1 });
    const [a] = students;
    // A single student holds every piece after start.

    const clamped = await takeOk(a, groupId, [3, 2], 9999, 9999);
    const want = clampPosition(layout, [[3, 2]], 9999, 9999);
    expect([clamped.x, clamped.y]).toEqual([want.x, want.y]);

    const first = await takeOk(a, groupId, [0, 0], FAR.x, FAR.y);
    const second = await takeOk(a, groupId, [1, 0], FAR.x + 15, FAR.y - 10);
    expect(second.absorbed).toHaveLength(1);
    expect(second.id).toBe(Math.min(first.cluster_id, second.cluster_id));
    expect([second.x, second.y]).toEqual([FAR.x, FAR.y]);

    const frame = frameOrigin(layout);
    const fixed = await takeOk(a, groupId, [1, 1], frame.x + 20, frame.y - 30);
    expect(fixed).toMatchObject({ x: frame.x, y: frame.y, locked: true, progress: { placed: 1 } });
    expect((await pieceRow(groupId, [1, 1])).locked).toBe(true);
  });

  it('다른 모둠은 not_found, 교사는 거부, 시작 전에는 not_playing', async () => {
    const { groupIds, students } = await playing({ groups: 2 });
    const [a] = students;
    expect((await take(a, groupIds[1], [0, 0], 0, 0)).data).toEqual({ ok: false, reason: 'not_found' });
    const byTeacher = await teacher.client.rpc('take_from_tray', {
      p_group: groupIds[0],
      p_piece: 0,
      p_x: 0,
      p_y: 0,
    });
    expect(byTeacher.error).toMatchObject({ code: FORBIDDEN });

    const waiting = await playing({ count: 1, start: false });
    expect((await take(waiting.students[0], waiting.groupId, [0, 0], 0, 0)).data).toEqual({
      ok: false,
      reason: 'not_playing',
    });
  });
});

describe('grab', () => {
  it('두 학생이 동시에 잡으면 한 명만 성공하고, 진 쪽은 held 와 잡은 사람을 받는다', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await giveTray(groupId, a.userId, [[0, 0], [2, 0], [0, 2], [2, 2], [3, 1]]);
    for (const cell of [[0, 0], [2, 0], [0, 2], [2, 2], [3, 1]]) {
      const placed = await takeOk(a, groupId, cell, FAR.x - cell[0] * 100, FAR.y - cell[1] * 100 + 50);
      await touch(a, b);
      const [ra, rb] = await Promise.all([
        a.client.rpc('grab', { p_cluster: placed.id }),
        b.client.rpc('grab', { p_cluster: placed.id }),
      ]);
      const results = [ra.data, rb.data];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const winner = ra.data.ok ? a : b;
      const loser = results.find((r) => !r.ok);
      expect(loser).toEqual({ ok: false, reason: 'held', held_by: winner.userId });
      expect((await pieceRow(groupId, cell)).grabbed_by).toBe(winner.userId);
    }
  });

  it('잡은 지 10초가 지났거나, 잡은 사람이 끊겼거나, 모둠을 떠났으면 다른 학생이 잡는다', async () => {
    const { groupId, groupIds, students } = await playing({ count: 2, groups: 2 });
    const [a, b] = students;
    await giveTray(groupId, a.userId, [[0, 0]]);
    const { id } = await takeOk(a, groupId, [0, 0], FAR.x, FAR.y);
    await touch(a, b);
    const grab = (s) => s.client.rpc('grab', { p_cluster: id }).then((r) => r.data);

    expect((await grab(a)).ok).toBe(true);
    expect(await grab(b)).toMatchObject({ ok: false, reason: 'held' });
    expect((await grab(a)).ok).toBe(true); // grabbing my own cluster again is fine

    await sql("update public.clusters set grabbed_at = now() - interval '11 seconds' where id = $1", [id]);
    expect((await grab(b)).ok).toBe(true);

    await touch(a, b);
    await sql("update public.members set last_seen = now() - interval '20 seconds' where user_id = $1", [b.userId]);
    expect((await grab(a)).ok).toBe(true); // b is disconnected

    await touch(a, b);
    expect(await grab(b)).toMatchObject({ ok: false, reason: 'held', held_by: a.userId });
    await rpcOk(teacher.client, 'assign_member', { p_member: a.memberId, p_group: groupIds[1] });
    await sql('update public.clusters set grabbed_by = $1, grabbed_at = now() where id = $2', [a.userId, id]);
    expect((await grab(b)).ok).toBe(true); // a is no longer in this group
  });

  it('고정된 덩어리는 locked, 상자 안 조각·다른 모둠 덩어리는 not_found, 교사는 거부', async () => {
    const { groupId, students, layout } = await playing({ count: 1 });
    const [a] = students;
    const frame = frameOrigin(layout);
    const fixed = await takeOk(a, groupId, [0, 0], frame.x, frame.y);
    expect(fixed.locked).toBe(true);
    expect((await a.client.rpc('grab', { p_cluster: fixed.id })).data).toEqual({ ok: false, reason: 'locked' });

    const inTray = await pieceRow(groupId, [3, 2]);
    expect((await a.client.rpc('grab', { p_cluster: inTray.cluster_id })).data).toEqual({
      ok: false,
      reason: 'not_found',
    });
    const other = await playing({ count: 1 });
    const theirs = await takeOk(other.students[0], other.groupId, [0, 0], FAR.x, FAR.y);
    expect((await a.client.rpc('grab', { p_cluster: theirs.id })).data).toEqual({ ok: false, reason: 'not_found' });
    expect((await a.client.rpc('grab', { p_cluster: 9_000_000_000 })).data).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect((await teacher.client.rpc('grab', { p_cluster: fixed.id })).error).toMatchObject({ code: FORBIDDEN });
  });
});

describe('drop', () => {
  it('잡은 사람만 놓을 수 있고, 위치가 이상하면 bad_position 이며 잡은 상태가 유지된다', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await giveTray(groupId, a.userId, [[0, 0]]);
    const { id } = await takeOk(a, groupId, [0, 0], FAR.x, FAR.y);
    const drop = (s, x, y) => s.client.rpc('drop', { p_cluster: id, p_x: x, p_y: y }).then((r) => r.data);

    expect(await drop(a, 10, 10)).toEqual({ ok: false, reason: 'not_held' }); // not grabbed yet
    await touch(a, b);
    await rpcOk(a.client, 'grab', { p_cluster: id });
    expect(await drop(b, 10, 10)).toEqual({ ok: false, reason: 'not_held' });
    for (const [x, y] of [['NaN', 1], [1, 'Infinity'], ['-Infinity', 1], [null, 1]]) {
      expect(await drop(a, x, y)).toEqual({ ok: false, reason: 'bad_position' });
    }
    expect(await pieceRow(groupId, [0, 0])).toMatchObject({ x: FAR.x, y: FAR.y, grabbed_by: a.userId });

    // Taken over after 10 seconds: the first holder can no longer drop it.
    await sql("update public.clusters set grabbed_at = now() - interval '11 seconds' where id = $1", [id]);
    await rpcOk(b.client, 'grab', { p_cluster: id });
    expect(await drop(a, 10, 10)).toEqual({ ok: false, reason: 'not_held' });
    const dropped = await drop(b, 200, 150);
    expect(dropped).toMatchObject({ ok: true, cluster_id: id, id, x: 200, y: 150, absorbed: [] });
    expect((await pieceRow(groupId, [0, 0])).grabbed_by).toBeNull();
    expect((await a.client.rpc('drop', { p_cluster: 9_000_000_000, p_x: 0, p_y: 0 })).data).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('맞는 이웃 가까이 놓으면 한 덩어리가 되고, 그 뒤에는 함께 움직인다', async () => {
    const { groupId, students } = await playing({ count: 1 });
    const [a] = students;
    const left = await takeOk(a, groupId, [0, 0], FAR.x, FAR.y);
    const right = await takeOk(a, groupId, [1, 0], 150, 180);
    await rpcOk(a.client, 'grab', { p_cluster: right.id });
    const merged = await rpcOk(a.client, 'drop', { p_cluster: right.id, p_x: FAR.x + 20, p_y: FAR.y + 30 });
    const survivor = Math.min(left.id, right.id);
    expect(merged).toMatchObject({ id: survivor, x: FAR.x, y: FAR.y, absorbed: [Math.max(left.id, right.id)] });
    const { rows: gone } = await sql('select count(*)::int as n from public.clusters where id = $1', [
      Math.max(left.id, right.id),
    ]);
    expect(gone[0].n).toBe(0);

    await rpcOk(a.client, 'grab', { p_cluster: survivor });
    await rpcOk(a.client, 'drop', { p_cluster: survivor, p_x: 200, p_y: 150 });
    const [p0, p1] = [await pieceRow(groupId, [0, 0]), await pieceRow(groupId, [1, 0])];
    expect(p0).toMatchObject({ cluster_id: survivor, x: 200, y: 150 });
    expect(p1).toMatchObject({ cluster_id: survivor, x: 200, y: 150 });
  });

  it('다른 학생이 잡고 있는 덩어리에는 붙지 않고, 잠금이 풀리면 붙는다', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await giveTray(groupId, a.userId, [[0, 0], [1, 0]]);
    const held = await takeOk(a, groupId, [0, 0], FAR.x, FAR.y);
    await touch(a, b);
    await rpcOk(b.client, 'grab', { p_cluster: held.id });

    const next = await takeOk(a, groupId, [1, 0], FAR.x, FAR.y);
    expect(next.absorbed).toEqual([]);
    expect(await pieceRow(groupId, [0, 0])).toMatchObject({ cluster_id: held.id, grabbed_by: b.userId });

    await sql("update public.clusters set grabbed_at = now() - interval '11 seconds' where id = $1", [held.id]);
    await rpcOk(a.client, 'grab', { p_cluster: next.id });
    const merged = await rpcOk(a.client, 'drop', { p_cluster: next.id, p_x: FAR.x, p_y: FAR.y });
    expect(merged).toMatchObject({ id: held.id, absorbed: [next.id] });
    expect((await pieceRow(groupId, [0, 0])).grabbed_by).toBeNull();
  });

  it('제자리에 고정된 덩어리에 이웃이 붙으면 고정 쪽 위치·id 로 합쳐진다', async () => {
    const { groupId, students, layout } = await playing({ count: 1 });
    const [a] = students;
    const frame = frameOrigin(layout);
    const fixed = await takeOk(a, groupId, [1, 1], frame.x, frame.y);
    const big = await takeOk(a, groupId, [2, 1], FAR.x - 100, FAR.y - 100);
    await takeOk(a, groupId, [3, 1], FAR.x - 100, FAR.y - 100); // big is now 2 pieces
    await rpcOk(a.client, 'grab', { p_cluster: big.id });
    const result = await rpcOk(a.client, 'drop', { p_cluster: big.id, p_x: frame.x + 25, p_y: frame.y + 25 });
    expect(result).toMatchObject({
      id: fixed.id,
      x: frame.x,
      y: frame.y,
      locked: true,
      absorbed: [big.id],
      progress: { placed: 3, total: 12, complete: false },
    });
  });

  it('마지막 조각이 제자리에 고정되면 완성 시각을 한 번 기록하고 모둠 채널에 알린다', async () => {
    const { groupId, students, layout } = await playing({ count: 2 });
    const [a, b] = students;
    const cells = [];
    for (let row = 0; row < 3; row += 1) for (let col = 0; col < 4; col += 1) cells.push([col, row]);
    await giveTray(groupId, a.userId, cells);
    const sub = await subscribe(b.client, `group:${groupId}`);
    expect(sub.status).toBe('SUBSCRIBED');
    await warmUp(sub, `group:${groupId}`);

    const frame = frameOrigin(layout);
    const results = [];
    for (const cell of cells) results.push(await takeOk(a, groupId, cell, frame.x + 3, frame.y - 4));
    expect(results.slice(0, -1).every((r) => r.completed_now === false && r.completed_at === null)).toBe(true);
    const last = results.at(-1);
    expect(last).toMatchObject({ locked: true, completed_now: true, progress: { placed: 12, total: 12, complete: true } });
    expect(last.completed_at).toBeTruthy();

    const { rows } = await sql(
      `select g.completed_at, count(distinct c.id)::int as clusters
       from public.groups g join public.clusters c on c.group_id = g.id
       join public.pieces p on p.cluster_id = c.id and p.on_board
       where g.id = $1 group by g.completed_at`,
      [groupId],
    );
    expect(rows[0].clusters).toBe(1);
    expect(new Date(rows[0].completed_at).toISOString()).toBe(new Date(last.completed_at).toISOString());

    expect(await waitFor(() => sub.received.filter((m) => m.event === 'take').length === 12)).toBe(true);
    const lastTake = sub.received.filter((m) => m.event === 'take').at(-1).payload;
    expect(lastTake).toMatchObject({ by: a.userId, completed_now: true, progress: { complete: true } });
  });
});

describe('방송 (group:<id>)', () => {
  it('꺼내기·잡기·놓기(합치기)를 모둠원에게 보내고, 좌표는 float8 그대로다', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await giveTray(groupId, a.userId, [[0, 0], [1, 0]]);
    const sub = await subscribe(b.client, `group:${groupId}`);
    expect(sub.status).toBe('SUBSCRIBED');
    await warmUp(sub, `group:${groupId}`);

    const x = 0.1 + 0.2; // 0.30000000000000004 needs 17 significant digits
    const y = 250 + 1 / 3;
    const taken = await takeOk(a, groupId, [0, 0], x, y);
    expect(Object.is(taken.x, x) && Object.is(taken.y, y)).toBe(true);
    const other = await takeOk(a, groupId, [1, 0], 400, 300);
    await rpcOk(a.client, 'grab', { p_cluster: other.id });
    const dropped = await rpcOk(a.client, 'drop', { p_cluster: other.id, p_x: x + 10, p_y: y });

    expect(await waitFor(() => sub.received.filter((m) => m.event !== 'warmup').length >= 4)).toBe(true);
    const events = sub.received.map((m) => m.event);
    expect(events).toEqual(['take', 'take', 'grab', 'drop']);
    const [t1, , g, d] = sub.received.map((m) => m.payload);
    expect(t1).toMatchObject({ by: a.userId, piece: 0, cluster_id: taken.cluster_id, id: taken.id, locked: false });
    expect(Object.is(t1.x, x) && Object.is(t1.y, y)).toBe(true);
    expect(g).toMatchObject({ by: a.userId, cluster_id: other.id });
    expect(g.grabbed_at).toBeTruthy();
    expect(d).toMatchObject({
      by: a.userId,
      cluster_id: other.id,
      id: dropped.id,
      absorbed: dropped.absorbed,
      progress: { placed: 0, total: 12, complete: false },
    });
    expect(Object.is(d.x, x)).toBe(true);
  });

  it('호출한 쪽이 extra_float_digits = 0 이어도 결과와 방송 내용의 좌표가 잘리지 않는다', async () => {
    const { groupId, students } = await playing({ count: 1 });
    const [a] = students;
    const x = 0.1 + 0.2;
    const conn = await dbClient();
    await beginAsStudent(conn, a.userId);
    await conn.query('set local extra_float_digits = 0');
    const { rows } = await conn.query('select public.take_from_tray($1, $2, $3, $4) as r', [
      groupId,
      0,
      String(x),
      '250.33333333333334',
    ]);
    expect(Object.is(rows[0].r.x, x)).toBe(true);
    expect(rows[0].r.y).toBe(250.33333333333334);
    await conn.query('reset role');
    const { rows: sent } = await conn.query(
      `select payload from realtime.messages where topic = $1 and event = 'take'
       order by inserted_at desc limit 1`,
      [`group:${groupId}`],
    );
    expect(Object.is(sent[0].payload.x, x)).toBe(true);
    await conn.query('rollback');
  });
});

describe('T4 참고 1: 조각 나누기와 꺼내기 경쟁', () => {
  // Starts a take_from_tray in an open transaction, runs `other` while it is open and
  // commits after `other` had time to block on the piece row.
  async function raceTake(student, groupId, cell, other) {
    const conn = await dbClient();
    await beginAsStudent(conn, student.userId);
    const { rows } = await conn.query('select public.take_from_tray($1, $2, $3, $4) as r', [
      groupId,
      pieceOf(cell),
      FAR.x,
      FAR.y,
    ]);
    expect(rows[0].r.ok).toBe(true);
    let finished = false;
    const pending = other().then((value) => {
      finished = true;
      return value;
    });
    await sleep(400);
    const blocked = !finished;
    await conn.query('commit');
    return { result: await pending, blocked };
  }

  it('deal_tray 가 꺼내는 중인 조각을 기다렸다가 건너뛴다(판 위 조각에 주인이 다시 생기지 않음)', async () => {
    const { groupId, students } = await playing({ count: 2 });
    const [a, b] = students;
    await sql('update public.pieces set owner_id = $1 where group_id = $2', [b.userId, groupId]);
    await giveTray(groupId, a.userId, [[0, 0], [1, 0], [2, 0]]);

    const { result, blocked } = await raceTake(a, groupId, [0, 0], () =>
      sql('select private.deal_tray($1, $2::uuid[], $3::uuid[]) as dealt', [groupId, [a.userId], [b.userId]]),
    );
    expect(blocked).toBe(true);
    const dealt = result.rows[0].dealt;
    expect(dealt.map((p) => [p.col, p.row]).sort()).toEqual([[1, 0], [2, 0]]);
    expect(await pieceRow(groupId, [0, 0])).toMatchObject({ on_board: true, owner_id: null });
    expect((await pieceRow(groupId, [1, 0])).owner_id).toBe(b.userId);
  });

  it('교사가 꺼내는 중인 학생을 다른 모둠으로 옮겨도 판 위 조각은 주인 없이 남는다', async () => {
    const { groupId, groupIds, students } = await playing({ count: 2, groups: 2 });
    const [a, b] = students;
    await touch(a, b);
    await sql('update public.pieces set owner_id = $1 where group_id = $2', [b.userId, groupId]);
    await giveTray(groupId, a.userId, [[0, 0], [1, 0]]);

    await raceTake(a, groupId, [0, 0], () =>
      rpcOk(teacher.client, 'assign_member', { p_member: a.memberId, p_group: groupIds[1] }),
    );
    expect(await pieceRow(groupId, [0, 0])).toMatchObject({ on_board: true, owner_id: null });
    expect((await pieceRow(groupId, [1, 0])).owner_id).toBe(b.userId);
    const { rows } = await sql(
      'select count(*)::int as n from public.pieces where group_id = $1 and owner_id is not null and on_board',
      [groupId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('잠금 순서 (모둠 행 → 덩어리)', () => {
  // Holds the group row like a drop in progress, starts `call` and checks that while it
  // waits for the group it has not locked any cluster of that group yet.
  async function expectGroupLockFirst(groupId, clusterId, call) {
    const holder = await dbClient();
    await holder.query('begin');
    await holder.query('select 1 from public.groups where id = $1 for update', [groupId]);
    let finished = false;
    const pending = call().then((value) => {
      finished = true;
      return value;
    });
    await sleep(400);
    expect(finished).toBe(false);

    const probe = await dbClient();
    await probe.query('begin');
    const free = await probe
      .query('select id from public.clusters where id = $1 for update nowait', [clusterId])
      .then(() => true, (error) => error.code);
    await probe.query('rollback');
    await holder.query('commit');
    await pending;
    return free;
  }

  async function heldCluster(groupId, student) {
    await giveTray(groupId, student.userId, [[0, 0]]);
    const { id } = await takeOk(student, groupId, [0, 0], FAR.x, FAR.y);
    await sql('update public.clusters set grabbed_by = $1, grabbed_at = now() where id = $2', [student.userId, id]);
    return id;
  }

  it('assign_member 는 잡은 덩어리를 놓기 전에 모둠 행부터 잠근다', async () => {
    const { groupId, groupIds, students } = await playing({ count: 2, groups: 2 });
    const [a] = students;
    const clusterId = await heldCluster(groupId, a);
    const free = await expectGroupLockFirst(groupId, clusterId, () =>
      rpcOk(teacher.client, 'assign_member', { p_member: a.memberId, p_group: groupIds[1] }),
    );
    expect(free).toBe(true);
    expect((await pieceRow(groupId, [0, 0])).grabbed_by).toBeNull();
  });

  it('end_session 은 계정을 지우고 잡기를 풀기 전에 모둠 행부터 잠근다', async () => {
    const { session, groupId, students } = await playing({ count: 2 });
    const [a] = students;
    const clusterId = await heldCluster(groupId, a);
    const free = await expectGroupLockFirst(groupId, clusterId, () =>
      rpcOk(teacher.client, 'end_session', { p_session: session.id }),
    );
    expect(free).toBe(true);
    expect((await pieceRow(groupId, [0, 0])).grabbed_by).toBeNull();
  });

  it('놓기와 모둠 옮기기·수업 끝내기를 동시에 여러 번 불러도 교착 없이 끝난다', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { session, groupId, groupIds, students } = await playing({ count: 3, groups: 2 });
      const [a, b, c] = students;
      await touch(a, b, c);
      const cells = [[0, 0], [1, 0], [2, 0], [3, 0]];
      await giveTray(groupId, a.userId, cells.slice(0, 2));
      await giveTray(groupId, b.userId, cells.slice(2));
      const ids = [];
      for (const [i, cell] of cells.entries()) {
        ids.push((await takeOk(i < 2 ? a : b, groupId, cell, FAR.x - 60 * i, FAR.y - 40 * i)).id);
      }
      await rpcOk(a.client, 'grab', { p_cluster: ids[0] });
      await rpcOk(a.client, 'grab', { p_cluster: ids[3] });
      await rpcOk(b.client, 'grab', { p_cluster: ids[1] });
      await giveTray(groupId, c.userId, [[3, 2]]);
      const results = await Promise.all([
        b.client.rpc('drop', { p_cluster: ids[1], p_x: FAR.x, p_y: FAR.y }),
        teacher.client.rpc('assign_member', { p_member: a.memberId, p_group: groupIds[1] }),
        take(c, groupId, [3, 2], 10, 10),
        teacher.client.rpc('end_session', { p_session: session.id }),
      ]);
      // Whichever runs after end_session may be refused by the rules (session_ended,
      // or not_found once the members are gone), but nothing may fail with a deadlock.
      for (const { error } of results) {
        if (error) expect(error, JSON.stringify(error)).toMatchObject({ code: '55000', message: 'session_ended' });
      }
      expect(results[3].error).toBeNull();
    }
  });
});

