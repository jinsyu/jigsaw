// T4: class flow RPCs — create_session, join_session, assign_member, randomize_groups,
// start_session, end_session (D3, D4, D5, D14).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PIECE_COUNTS, gridFor, layoutFor, makePuzzle } from '../../public/js/puzzle/geometry.js';
import {
  TEACHERS,
  cleanup,
  deleteSessions,
  insertImageRow,
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
const INVALID = '22023';
const WRONG_STATE = '55000';

let teacher1;
let teacher2;
const sessionIds = [];
const imageIds = [];

async function openSession(teacher = teacher1, args = {}) {
  const session = await rpcOk(teacher.client, 'create_session', {
    p_piece_count: 24,
    p_group_count: 2,
    p_builtin_key: 'test-scene',
    p_aspect: 4 / 3,
    ...args,
  });
  sessionIds.push(session.id);
  return session;
}

async function groupIdsOf(sessionId) {
  const { rows } = await sql('select id from public.groups where session_id = $1 order by number', [
    sessionId,
  ]);
  return rows.map((r) => Number(r.id));
}

async function joinStudents(code, count) {
  const students = await Promise.all(Array.from({ length: count }, () => studentClient()));
  for (const student of students) {
    const result = await rpcOk(student.client, 'join_session', { p_code: code });
    expect(result.ok).toBe(true);
    student.memberId = result.member_id;
  }
  return students;
}

async function assign(students, groupId, teacher = teacher1) {
  for (const student of students) {
    await rpcOk(teacher.client, 'assign_member', { p_member: student.memberId, p_group: groupId });
  }
}

// Tray piece count per owner in a group: { [uid]: n } (null key = nobody's tray).
async function trayCounts(groupId) {
  const { rows } = await sql(
    `select owner_id, count(*)::int as n from public.pieces
     where group_id = $1 and not on_board group by owner_id`,
    [groupId],
  );
  return Object.fromEntries(rows.map((r) => [r.owner_id, r.n]));
}

const sortedCounts = (counts) => Object.values(counts).sort((a, b) => a - b);

beforeAll(async () => {
  teacher1 = await teacherClient(TEACHERS.one);
  teacher2 = await teacherClient(TEACHERS.two);
});

afterEach(leaveAllChannels);

afterAll(async () => {
  await deleteSessions(sessionIds);
  if (imageIds.length) await sql('delete from public.images where id = any($1::uuid[])', [imageIds]);
  await cleanup();
});

describe('create_session', () => {
  it('교사가 수업을 열면 6자리 코드·시드·격자·모둠이 만들어진다', async () => {
    const session = await openSession(teacher1, { p_piece_count: 24, p_group_count: 6 });
    expect(session.code).toMatch(/^[0-9]{6}$/);
    expect(session.status).toBe('waiting');
    expect(session.teacher_id).toBe(TEACHERS.one.id);
    expect(session.seed).toBeGreaterThanOrEqual(1);
    expect(session.seed).toBeLessThanOrEqual(2 ** 32 - 1);
    expect(Object.is(session.aspect, 4 / 3)).toBe(true);
    expect({ cols: session.cols, rows: session.rows }).toEqual(gridFor(24, 4 / 3));
    const { rows } = await sql('select number from public.groups where session_id = $1 order by number', [
      session.id,
    ]);
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('SQL 격자 계산이 geometry.gridFor 와 같다 (세로 그림은 행열을 바꾼다)', async () => {
    const aspects = [4 / 3, 1, 1 - 1e-9, 3 / 4, 16 / 9, 1920 / 1081, 0.5, 2000 / 1999];
    for (const pieceCount of PIECE_COUNTS) {
      for (const aspect of aspects) {
        const { rows } = await sql('select cols, rows from private.grid_for($1, $2)', [pieceCount, aspect]);
        expect(rows[0], `${pieceCount} @ ${aspect}`).toEqual(gridFor(pieceCount, aspect));
      }
    }
    const portrait = await openSession(teacher1, { p_piece_count: 70, p_aspect: 3 / 4 });
    expect([portrait.cols, portrait.rows]).toEqual([7, 10]);
  });

  it('내 그림으로 열면 비율은 너비/높이(JS 와 같은 실수)이고 마지막 사용일이 갱신된다', async () => {
    const image = await insertImageRow(TEACHERS.one.id, { width: 1999, height: 1123 });
    imageIds.push(image.id);
    await sql("update public.images set last_used_at = now() - interval '200 days' where id = $1", [
      image.id,
    ]);
    const session = await openSession(teacher1, {
      p_builtin_key: null,
      p_aspect: null,
      p_image_id: image.id,
    });
    expect(Object.is(session.aspect, 1999 / 1123)).toBe(true);
    expect(session.image_id).toBe(image.id);
    expect(session.builtin_key).toBeNull();
    const { rows } = await sql(
      "select last_used_at > now() - interval '1 minute' as fresh from public.images where id = $1",
      [image.id],
    );
    expect(rows[0].fresh).toBe(true);
  });

  it('다른 교사의 그림, 그림 없음, 그림 둘 다는 거부된다', async () => {
    const image = await insertImageRow(TEACHERS.one.id);
    imageIds.push(image.id);
    const attempts = [
      { p_builtin_key: null, p_aspect: null, p_image_id: image.id },
      { p_builtin_key: null, p_aspect: 1 },
      { p_builtin_key: 'test-scene', p_image_id: image.id },
      { p_builtin_key: 'Bad Key', p_aspect: 1 },
      { p_builtin_key: 'test-scene', p_aspect: null },
    ];
    for (const args of attempts) {
      const { error } = await teacher2.client.rpc('create_session', {
        p_piece_count: 12,
        p_group_count: 2,
        p_builtin_key: 'test-scene',
        p_aspect: 1,
        ...args,
      });
      expect(error, JSON.stringify(args)).toMatchObject({ code: INVALID, message: 'invalid_picture' });
    }
  });

  it('조각 수·모둠 수가 정해진 범위 밖이면 거부된다', async () => {
    const call = (args) =>
      teacher1.client.rpc('create_session', {
        p_piece_count: 24,
        p_group_count: 2,
        p_builtin_key: 'test-scene',
        p_aspect: 1,
        ...args,
      });
    expect((await call({ p_piece_count: 25 })).error).toMatchObject({
      code: INVALID,
      message: 'invalid_piece_count',
    });
    for (const p_group_count of [0, 13]) {
      expect((await call({ p_group_count })).error).toMatchObject({
        code: INVALID,
        message: 'invalid_group_count',
      });
    }
  });

  it('열린 수업끼리 코드가 겹치지 않는다', async () => {
    const sessions = [];
    for (let i = 0; i < 15; i += 1) sessions.push(await openSession(teacher2, { p_group_count: 1 }));
    const { rows } = await sql(
      "select code, count(*)::int as n from public.sessions where status <> 'ended' group by code having count(*) > 1",
    );
    expect(rows).toEqual([]);
    expect(new Set(sessions.map((s) => s.code)).size).toBe(sessions.length);
  });

  it('학생(익명 사용자)이 부르면 거부된다', async () => {
    const student = await studentClient();
    const { error } = await student.client.rpc('create_session', {
      p_piece_count: 12,
      p_group_count: 1,
      p_builtin_key: 'test-scene',
      p_aspect: 1,
    });
    expect(error).toMatchObject({ code: FORBIDDEN, message: 'forbidden' });
  });
});

describe('join_session', () => {
  let session;
  beforeAll(async () => {
    session = await openSession();
  });

  it('맞는 코드로 들어오면 members 행이 생기고, 같은 계정이 다시 들어오면 그 행을 돌려준다', async () => {
    const student = await studentClient();
    const first = await rpcOk(student.client, 'join_session', { p_code: session.code });
    expect(first).toMatchObject({ ok: true, session_id: session.id, group_id: null, status: 'waiting' });
    const groupId = (await groupIdsOf(session.id))[0];
    await rpcOk(teacher1.client, 'assign_member', { p_member: first.member_id, p_group: groupId });

    const again = await rpcOk(student.client, 'join_session', { p_code: session.code });
    expect(again).toMatchObject({ ok: true, member_id: first.member_id, group_id: groupId, color: 0 });
    const { rows } = await sql('select count(*)::int as n from public.members where user_id = $1', [
      student.userId,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('틀린 코드는 invalid_code 를 돌려주고 members 행이 생기지 않는다', async () => {
    const student = await studentClient();
    const wrong = session.code === '000000' ? '000001' : '000000';
    for (const code of [wrong, '12345', 'abcdef', '']) {
      const result = await rpcOk(student.client, 'join_session', { p_code: code });
      expect(result).toEqual({ ok: false, error: 'invalid_code' });
    }
    const { rows } = await sql('select count(*)::int as n from public.members where user_id = $1', [
      student.userId,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('끝난 수업의 코드는 invalid_code 다', async () => {
    const closed = await openSession();
    await rpcOk(teacher1.client, 'end_session', { p_session: closed.id });
    const student = await studentClient();
    expect(await rpcOk(student.client, 'join_session', { p_code: closed.code })).toEqual({
      ok: false,
      error: 'invalid_code',
    });
  });

  it('1분 안에 10번 틀리면 맞는 코드도 잠시 거부된다', async () => {
    const student = await studentClient();
    const wrong = session.code === '999999' ? '999998' : '999999';
    for (let i = 0; i < 10; i += 1) await rpcOk(student.client, 'join_session', { p_code: wrong });
    expect(await rpcOk(student.client, 'join_session', { p_code: session.code })).toEqual({
      ok: false,
      error: 'too_many_attempts',
    });
    // The lockout ends once the failures are older than a minute.
    await sql("update private.join_failures set failed_at = now() - interval '61 seconds' where user_id = $1", [
      student.userId,
    ]);
    expect((await rpcOk(student.client, 'join_session', { p_code: session.code })).ok).toBe(true);
  });

  it('교사 계정은 학생으로 들어올 수 없다', async () => {
    const { error } = await teacher2.client.rpc('join_session', { p_code: session.code });
    expect(error).toMatchObject({ code: FORBIDDEN });
  });
});

describe('assign_member · randomize_groups', () => {
  it('교사가 학생을 모둠에 넣고 빼면 색 번호가 정해지고 session 채널에 알린다', async () => {
    const session = await openSession();
    const [g1] = await groupIdsOf(session.id);
    const [a, b] = await joinStudents(session.code, 2);
    const watcher = await subscribe(teacher1.client, `session:${session.id}`);
    await warmUp(watcher, `session:${session.id}`);

    const first = await rpcOk(teacher1.client, 'assign_member', { p_member: a.memberId, p_group: g1 });
    const second = await rpcOk(teacher1.client, 'assign_member', { p_member: b.memberId, p_group: g1 });
    expect([first.color, second.color]).toEqual([0, 1]);
    const back = await rpcOk(teacher1.client, 'assign_member', { p_member: a.memberId, p_group: null });
    expect(back).toMatchObject({ group_id: null, color: null });

    expect(await waitFor(() => watcher.received.filter((m) => m.event === 'groups').length >= 3)).toBe(true);
    expect(watcher.received.map((m) => m.payload.members[0])).toEqual([
      { member_id: a.memberId, group_id: g1, color: 0 },
      { member_id: b.memberId, group_id: g1, color: 1 },
      { member_id: a.memberId, group_id: null, color: null },
    ]);
  });

  it('다른 교사·학생은 모둠을 바꾸지 못하고, 다른 수업 모둠으로는 넣을 수 없다', async () => {
    const session = await openSession();
    const other = await openSession(teacher2);
    const [g1] = await groupIdsOf(session.id);
    const [otherGroup] = await groupIdsOf(other.id);
    const [student] = await joinStudents(session.code, 1);

    const byTeacher2 = await teacher2.client.rpc('assign_member', { p_member: student.memberId, p_group: g1 });
    expect(byTeacher2.error).toMatchObject({ code: FORBIDDEN });
    const byStudent = await student.client.rpc('assign_member', { p_member: student.memberId, p_group: g1 });
    expect(byStudent.error).toMatchObject({ code: FORBIDDEN });
    const randomize = await student.client.rpc('randomize_groups', { p_session: session.id });
    expect(randomize.error).toMatchObject({ code: FORBIDDEN });
    const wrongGroup = await teacher1.client.rpc('assign_member', {
      p_member: student.memberId,
      p_group: otherGroup,
    });
    expect(wrongGroup.error).toMatchObject({ code: INVALID, message: 'invalid_group' });

    const { rows } = await sql('select group_id from public.members where id = $1', [student.memberId]);
    expect(rows[0].group_id).toBeNull();
  });

  it('무작위로 나누기: 13명 → 6모둠에 3·2·2·2·2·2명, 모둠 안 색 번호는 0부터 겹치지 않게', async () => {
    const session = await openSession(teacher1, { p_group_count: 6 });
    await joinStudents(session.code, 13);
    const members = await rpcOk(teacher1.client, 'randomize_groups', { p_session: session.id });
    expect(members).toHaveLength(13);

    const byGroup = new Map();
    for (const m of members) byGroup.set(m.group_id, [...(byGroup.get(m.group_id) ?? []), m.color]);
    expect([...byGroup.values()].map((c) => c.length).sort()).toEqual([2, 2, 2, 2, 2, 3]);
    for (const colors of byGroup.values()) {
      expect([...colors].sort()).toEqual(colors.map((_, i) => i));
    }
  });

  it('시작한 뒤에는 무작위로 나누기를 할 수 없다', async () => {
    const session = await openSession();
    await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
    const { error } = await teacher1.client.rpc('randomize_groups', { p_session: session.id });
    expect(error).toMatchObject({ code: WRONG_STATE, message: 'session_not_waiting' });
  });
});

describe('start_session', () => {
  it('24조각·5명 → 5·5·5·5·4, 모든 조각은 그 모둠 학생 상자에, 조각마다 덩어리 하나', async () => {
    const session = await openSession(teacher1, { p_piece_count: 24, p_group_count: 1 });
    const [g1] = await groupIdsOf(session.id);
    const students = await joinStudents(session.code, 5);
    await assign(students, g1);

    const started = await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
    expect(started.status).toBe('playing');
    expect(started.started_at).toBeTruthy();

    const counts = await trayCounts(g1);
    expect(sortedCounts(counts)).toEqual([4, 5, 5, 5, 5]);
    expect(Object.keys(counts).sort()).toEqual(students.map((s) => s.userId).sort());

    const { rows: pieces } = await sql(
      `select col, "row", cluster_id, on_board from public.pieces where group_id = $1 order by "row", col`,
      [g1],
    );
    expect(pieces.every((p) => p.on_board === false)).toBe(true);
    expect(new Set(pieces.map((p) => p.cluster_id)).size).toBe(24);
    // Same cells as the puzzle every device draws from the seed.
    const puzzle = makePuzzle(layoutFor(session.cols, session.rows, session.aspect), session.seed);
    expect(pieces.map((p) => [p.col, p.row])).toEqual(puzzle.pieces.map((p) => [p.col, p.row]));
  });

  it('여러 조각 수·모둠원 수에서 최대 1개 차이로 고르게 나눈다', async () => {
    const cases = [
      [12, [1, 2, 3, 4, 5, 6]],
      [70, [1, 3, 4, 6, 7, 2]],
      [48, [5, 4, 6]],
    ];
    for (const [pieceCount, sizes] of cases) {
      const session = await openSession(teacher1, {
        p_piece_count: pieceCount,
        p_group_count: sizes.length,
        p_aspect: 3 / 4,
      });
      const groups = await groupIdsOf(session.id);
      for (const [i, size] of sizes.entries()) {
        await assign(await joinStudents(session.code, size), groups[i]);
      }
      await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
      for (const [i, size] of sizes.entries()) {
        const counts = sortedCounts(await trayCounts(groups[i]));
        const label = `${pieceCount}조각 ${size}명`;
        expect(counts, label).toHaveLength(size);
        expect(counts.reduce((a, b) => a + b, 0), label).toBe(pieceCount);
        expect(counts.at(-1) - counts[0], label).toBeLessThanOrEqual(1);
      }
    }
  });

  it('모둠 안 색 번호는 0..n-1, 학생 없는 모둠은 퍼즐을 만들지 않는다', async () => {
    const session = await openSession(teacher1, { p_piece_count: 12, p_group_count: 3 });
    const [g1, g2, g3] = await groupIdsOf(session.id);
    await assign(await joinStudents(session.code, 3), g1);
    await assign(await joinStudents(session.code, 2), g3);
    await rpcOk(teacher1.client, 'start_session', { p_session: session.id });

    const { rows } = await sql(
      `select group_id, array_agg(color order by color) as colors from public.members
       where session_id = $1 group by group_id`,
      [session.id],
    );
    const colors = Object.fromEntries(rows.map((r) => [Number(r.group_id), r.colors]));
    expect(colors).toEqual({ [g1]: [0, 1, 2], [g3]: [0, 1] });
    const { rows: empty } = await sql('select count(*)::int as n from public.pieces where group_id = $1', [g2]);
    expect(empty[0].n).toBe(0);
  });

  it('시작하면 session 채널의 학생에게 start 알림이 간다', async () => {
    const session = await openSession(teacher1, { p_group_count: 1 });
    const [student] = await joinStudents(session.code, 1);
    const topic = `session:${session.id}`;
    const sub = await subscribe(student.client, topic);
    expect(sub.status).toBe('SUBSCRIBED');
    await warmUp(sub, topic);

    const started = await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
    expect(await waitFor(() => sub.received.some((m) => m.event === 'start'))).toBe(true);
    expect(sub.received.find((m) => m.event === 'start').payload).toMatchObject({
      session_id: session.id,
      started_at: started.started_at,
    });
  });

  it('교사가 아닌 사용자·다른 교사는 시작할 수 없고, 두 번 시작할 수 없다', async () => {
    const session = await openSession();
    const [student] = await joinStudents(session.code, 1);
    expect((await student.client.rpc('start_session', { p_session: session.id })).error).toMatchObject({
      code: FORBIDDEN,
    });
    expect((await teacher2.client.rpc('start_session', { p_session: session.id })).error).toMatchObject({
      code: FORBIDDEN,
    });
    await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
    expect((await teacher1.client.rpc('start_session', { p_session: session.id })).error).toMatchObject({
      code: WRONG_STATE,
      message: 'session_not_waiting',
    });
  });
});

describe('시작 뒤 모둠 배정·이동', () => {
  it('시작 뒤 배정된 학생은 상자가 없다', async () => {
    const session = await openSession(teacher1, { p_group_count: 1 });
    const [g1] = await groupIdsOf(session.id);
    await assign(await joinStudents(session.code, 2), g1);
    await rpcOk(teacher1.client, 'start_session', { p_session: session.id });

    const [late] = await joinStudents(session.code, 1);
    const member = await rpcOk(teacher1.client, 'assign_member', { p_member: late.memberId, p_group: g1 });
    expect(member.color).toBe(2);
    const counts = await trayCounts(g1);
    expect(counts[late.userId]).toBeUndefined();
    expect(sortedCounts(counts)).toEqual([12, 12]);
  });

  it('시작 뒤 다른 모둠으로 옮기면 남은 상자 조각은 원래 모둠 접속자에게 나뉘고, 잡은 덩어리는 놓인다', async () => {
    const session = await openSession(teacher1, { p_piece_count: 24, p_group_count: 2 });
    const [g1, g2] = await groupIdsOf(session.id);
    const students = await joinStudents(session.code, 5);
    await assign(students.slice(0, 4), g1);
    await assign(students.slice(4), g2);
    await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
    const [mover, offline, ...online] = students.slice(0, 4);

    // offline: last signal over 15 seconds ago, so it does not receive pieces.
    await sql("update public.members set last_seen = now() - interval '30 seconds' where id = $1", [
      offline.memberId,
    ]);
    const { rows: grabbed } = await sql(
      `update public.clusters set grabbed_by = $1, grabbed_at = now()
       where id = (select min(cluster_id) from public.pieces where group_id = $2) returning id`,
      [mover.userId, g1],
    );
    const watcher = await subscribe(teacher1.client, `group:${g1}`);
    await warmUp(watcher, `group:${g1}`);

    const before = await trayCounts(g1);
    expect(sortedCounts(before)).toEqual([6, 6, 6, 6]);
    await rpcOk(teacher1.client, 'assign_member', { p_member: mover.memberId, p_group: g2 });

    const after = await trayCounts(g1);
    expect(after[mover.userId]).toBeUndefined();
    expect(after[offline.userId]).toBe(6);
    expect(online.map((s) => after[s.userId]).sort()).toEqual([9, 9]);
    // The mover gets no tray in the new group either.
    expect((await trayCounts(g2))[mover.userId]).toBeUndefined();

    const { rows: released } = await sql('select grabbed_by from public.clusters where id = $1', [
      grabbed[0].id,
    ]);
    expect(released[0].grabbed_by).toBeNull();

    expect(await waitFor(() => watcher.received.some((m) => m.event === 'tray'))).toBe(true);
    const tray = watcher.received.find((m) => m.event === 'tray').payload.pieces;
    expect(tray).toHaveLength(6);
    expect(tray.every((p) => online.some((s) => s.userId === p.owner))).toBe(true);
    expect(watcher.received.find((m) => m.event === 'release').payload).toMatchObject({
      clusters: [Number(grabbed[0].id)],
    });
  });

  it('접속자가 없으면 남은 모둠원 모두에게, 아무도 안 남으면 다음에 배정되는 학생에게 간다', async () => {
    const session = await openSession(teacher1, { p_piece_count: 12, p_group_count: 2 });
    const [g1, g2] = await groupIdsOf(session.id);
    const [a, b] = await joinStudents(session.code, 2);
    await assign([a, b], g1);
    await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
    await sql("update public.members set last_seen = now() - interval '1 hour' where session_id = $1", [
      session.id,
    ]);

    await rpcOk(teacher1.client, 'assign_member', { p_member: a.memberId, p_group: g2 });
    expect(await trayCounts(g1)).toEqual({ [b.userId]: 12 });

    await rpcOk(teacher1.client, 'assign_member', { p_member: b.memberId, p_group: null });
    expect(await trayCounts(g1)).toEqual({ null: 12 });

    const [c] = await joinStudents(session.code, 1);
    await rpcOk(teacher1.client, 'assign_member', { p_member: c.memberId, p_group: g1 });
    expect(await trayCounts(g1)).toEqual({ [c.userId]: 12 });
  });

  it('학생 없이 시작한 모둠에 나중에 넣으면 그때 퍼즐을 만들고 조각을 모두 준다', async () => {
    const session = await openSession(teacher1, { p_piece_count: 12, p_group_count: 2 });
    const [g1, g2] = await groupIdsOf(session.id);
    await assign(await joinStudents(session.code, 1), g1);
    await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
    expect(await trayCounts(g2)).toEqual({});

    const [late] = await joinStudents(session.code, 1);
    await rpcOk(teacher1.client, 'assign_member', { p_member: late.memberId, p_group: g2 });
    expect(await trayCounts(g2)).toEqual({ [late.userId]: 12 });
  });
});

describe('Realtime 권한 캐시 (모둠 이동)', () => {
  it('옮긴 학생이 다시 구독하면 옛 모둠은 거부되고 새 모둠은 된다. 이미 연 옛 채널은 계속 받는다(알려진 한계)', async () => {
    const session = await openSession(teacher1, { p_group_count: 2 });
    const [g1, g2] = await groupIdsOf(session.id);
    const [student] = await joinStudents(session.code, 1);
    await assign([student], g1);

    const old = await subscribe(student.client, `group:${g1}`);
    expect(old.status).toBe('SUBSCRIBED');
    await warmUp(old, `group:${g1}`);

    await rpcOk(teacher1.client, 'assign_member', { p_member: student.memberId, p_group: g2 });
    await sql("select realtime.send('{\"n\":1}'::jsonb, 'probe', $1, true)", [`group:${g1}`]);
    // Realtime authorizes a channel when it is joined, not per message: the old channel still
    // receives. Clients therefore leave group:<old> as soon as they get the 'groups' event.
    expect(await waitFor(() => old.received.some((m) => m.event === 'probe'))).toBe(true);

    await student.client.removeChannel(old.channel);
    const rejoinOld = await subscribe(student.client, `group:${g1}`);
    expect(rejoinOld.status).toBe('CHANNEL_ERROR');
    const joinNew = await subscribe(student.client, `group:${g2}`);
    expect(joinNew.status).toBe('SUBSCRIBED');
  });
});

describe('end_session', () => {
  it('끝내면 members·그 학생 익명 계정이 0개가 되고, 모둠·수업 채널에 end 알림이 간다', async () => {
    const session = await openSession(teacher1, { p_piece_count: 12, p_group_count: 2 });
    const [g1, g2] = await groupIdsOf(session.id);
    const students = await joinStudents(session.code, 4);
    await assign(students.slice(0, 2), g1);
    await assign(students.slice(2, 3), g2);
    await rpcOk(teacher1.client, 'start_session', { p_session: session.id });

    const groupSub = await subscribe(students[0].client, `group:${g1}`);
    const sessionSub = await subscribe(students[3].client, `session:${session.id}`);
    expect([groupSub.status, sessionSub.status]).toEqual(['SUBSCRIBED', 'SUBSCRIBED']);
    await warmUp(groupSub, `group:${g1}`);
    await warmUp(sessionSub, `session:${session.id}`);

    const ended = await rpcOk(teacher1.client, 'end_session', { p_session: session.id });
    expect(ended.status).toBe('ended');
    expect(ended.ended_at).toBeTruthy();

    const { rows: members } = await sql('select count(*)::int as n from public.members where session_id = $1', [
      session.id,
    ]);
    expect(members[0].n).toBe(0);
    const { rows: users } = await sql('select count(*)::int as n from auth.users where id = any($1::uuid[])', [
      students.map((s) => s.userId),
    ]);
    expect(users[0].n).toBe(0);
    const { rows: teacher } = await sql('select count(*)::int as n from auth.users where id = $1', [
      TEACHERS.one.id,
    ]);
    expect(teacher[0].n).toBe(1);

    // Already joined channels still get the 'end' event although the accounts are gone.
    expect(await waitFor(() => groupSub.received.some((m) => m.event === 'end'))).toBe(true);
    expect(await waitFor(() => sessionSub.received.some((m) => m.event === 'end'))).toBe(true);
    expect(groupSub.received.find((m) => m.event === 'end').payload).toMatchObject({ session_id: session.id });
  });

  it('같은 계정이 아직 다른 열린 수업에 있으면 그 계정은 남긴다', async () => {
    const first = await openSession(teacher1, { p_group_count: 1 });
    const second = await openSession(teacher2, { p_group_count: 1 });
    const [student] = await joinStudents(first.code, 1);
    await rpcOk(student.client, 'join_session', { p_code: second.code });

    await rpcOk(teacher1.client, 'end_session', { p_session: first.id });
    const { rows } = await sql(
      `select (select count(*)::int from auth.users where id = $1) as users,
              (select count(*)::int from public.members where user_id = $1) as members`,
      [student.userId],
    );
    expect(rows[0]).toEqual({ users: 1, members: 1 });

    await rpcOk(teacher2.client, 'end_session', { p_session: second.id });
    const { rows: gone } = await sql('select count(*)::int as n from auth.users where id = $1', [
      student.userId,
    ]);
    expect(gone[0].n).toBe(0);
  });

  it('교사가 아닌 사용자·다른 교사는 끝낼 수 없고, 다시 끝내도 그대로다', async () => {
    const session = await openSession();
    const [student] = await joinStudents(session.code, 1);
    expect((await student.client.rpc('end_session', { p_session: session.id })).error).toMatchObject({
      code: FORBIDDEN,
    });
    expect((await teacher2.client.rpc('end_session', { p_session: session.id })).error).toMatchObject({
      code: FORBIDDEN,
    });
    const ended = await rpcOk(teacher1.client, 'end_session', { p_session: session.id });
    await sleep(10);
    const again = await rpcOk(teacher1.client, 'end_session', { p_session: session.id });
    expect(again.ended_at).toBe(ended.ended_at);
    const moved = await teacher1.client.rpc('assign_member', { p_member: student.memberId, p_group: null });
    expect(moved.error).toBeTruthy();
  });
});
