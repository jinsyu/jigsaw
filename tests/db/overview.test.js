// T12: session_overview — every board of a session for the teacher's 모둠 한눈에 보기 (D10, D11).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEACHERS,
  anonClient,
  cleanup,
  deleteSessions,
  rpcOk,
  sql,
  studentClient,
  teacherClient,
} from './helpers.js';

let teacher1;
let teacher2;
const sessionIds = [];

beforeAll(async () => {
  teacher1 = await teacherClient(TEACHERS.one);
  teacher2 = await teacherClient(TEACHERS.two);
});

afterAll(async () => {
  await deleteSessions(sessionIds);
  await cleanup();
});

// 12 pieces (4 x 3), three groups; students in groups 1 and 2 only, then started.
async function startedClass() {
  const session = await rpcOk(teacher1.client, 'create_session', {
    p_piece_count: 12,
    p_group_count: 3,
    p_builtin_key: 'test-scene',
    p_aspect: 4 / 3,
  });
  sessionIds.push(session.id);
  const { rows } = await sql('select id from public.groups where session_id = $1 order by number', [session.id]);
  const groupIds = rows.map((r) => Number(r.id));
  const students = await Promise.all([studentClient(), studentClient(), studentClient()]);
  for (const [i, student] of students.entries()) {
    const joined = await rpcOk(student.client, 'join_session', { p_code: session.code });
    student.memberId = joined.member_id;
    await rpcOk(teacher1.client, 'assign_member', { p_member: joined.member_id, p_group: groupIds[i === 2 ? 1 : 0] });
  }
  await rpcOk(teacher1.client, 'start_session', { p_session: session.id });
  return { session, groupIds, students };
}

describe('session_overview', () => {
  it('교사는 모둠마다 판 위 덩어리·진행률·완성 시각과 학생 행(이름 없음)을 한 번에 읽는다', async () => {
    const { session, groupIds, students } = await startedClass();
    const [g1, g2] = groupIds;

    // Group 1: piece (0,0) locked in the frame, piece (1,0) and (2,0) stuck together off the frame.
    const { rows: c1 } = await sql(
      'select cluster_id, col, "row" from public.pieces where group_id = $1 order by "row", col',
      [g1],
    );
    const clusterOf = (col, row) => Number(c1.find((p) => p.col === col && p.row === row).cluster_id);
    await sql('update public.pieces set on_board = true, owner_id = null where group_id = $1 and "row" = 0 and col < 3', [g1]);
    await sql('update public.clusters set x = 10.5, y = 20.25, locked = true where id = $1', [clusterOf(0, 0)]);
    await sql('update public.pieces set cluster_id = $1 where group_id = $2 and "row" = 0 and col = 2', [clusterOf(1, 0), g1]);
    await sql("update public.clusters set x = 1.7761332099907492, y = 3, z = 5, grabbed_by = $2, grabbed_at = now() where id = $1", [
      clusterOf(1, 0),
      students[0].userId,
    ]);
    // Group 2: complete.
    await sql('update public.pieces set on_board = true, owner_id = null where group_id = $1', [g2]);
    await sql('update public.clusters set locked = true where group_id = $1', [g2]);
    await sql("update public.groups set completed_at = now() where id = $1", [g2]);

    const overview = await rpcOk(teacher1.client, 'session_overview', { p_session: session.id });
    expect(overview.status).toBe('playing');
    expect(Date.parse(overview.now)).toBeGreaterThan(0);
    expect(Date.parse(overview.started_at)).toBeLessThanOrEqual(Date.parse(overview.now));
    expect(overview.groups.map((g) => g.number)).toEqual([1, 2, 3]);

    const [one, two, three] = overview.groups;
    expect(one).toMatchObject({ id: g1, total: 12, placed: 1, completed_at: null });
    // Locked first, then by z; tray pieces are not on the board.
    expect(one.clusters).toEqual([
      { id: clusterOf(0, 0), x: 10.5, y: 20.25, locked: true, held_by: null, pieces: [0] },
      { id: clusterOf(1, 0), x: 1.7761332099907492, y: 3, locked: false, held_by: students[0].userId, pieces: [1, 2] },
    ]);
    expect(two).toMatchObject({ id: g2, total: 12, placed: 12 });
    expect(two.completed_at).not.toBeNull();
    expect(two.clusters).toHaveLength(12);
    // No students at the start: no puzzle yet.
    expect(three).toMatchObject({ total: 0, placed: 0, clusters: [] });

    expect(overview.members).toHaveLength(3);
    for (const m of overview.members) {
      expect(Object.keys(m).sort()).toEqual(['color', 'group_id', 'id', 'last_seen', 'user_id']);
    }
    expect(overview.members.map((m) => m.group_id)).toEqual([g1, g1, g2]);
  });

  it('잡은 지 10초가 지난 덩어리는 잡은 사람을 보이지 않는다', async () => {
    const { session, groupIds, students } = await startedClass();
    await sql('update public.pieces set on_board = true, owner_id = null where group_id = $1 and "row" = 0 and col = 0', [groupIds[0]]);
    await sql(
      `update public.clusters set grabbed_by = $2, grabbed_at = now() - interval '11 seconds'
       where id = (select cluster_id from public.pieces where group_id = $1 and "row" = 0 and col = 0)`,
      [groupIds[0], students[1].userId],
    );
    const overview = await rpcOk(teacher1.client, 'session_overview', { p_session: session.id });
    expect(overview.groups[0].clusters).toEqual([expect.objectContaining({ pieces: [0], held_by: null })]);
  });

  it('다른 교사와 학생은 읽을 수 없다', async () => {
    const { session, students } = await startedClass();
    for (const client of [teacher2.client, students[0].client]) {
      const { data, error } = await client.rpc('session_overview', { p_session: session.id });
      expect(data).toBeNull();
      expect(error.code).toBe('42501');
    }
    // Not signed in (anon key only): no execute grant at all.
    const { data, error } = await anonClient().rpc('session_overview', { p_session: session.id });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it('접속이 끊긴 학생이 잡은 덩어리는 잡은 사람을 보이지 않는다 (서버 held_by_other 와 같은 기준)', async () => {
    const { session, groupIds, students } = await startedClass();
    const cell = 'select cluster_id from public.pieces where group_id = $1 and "row" = 0 and col = $2';
    await sql('update public.pieces set on_board = true, owner_id = null where group_id = $1 and "row" = 0 and col < 2', [groupIds[0]]);
    await sql(`update public.clusters set grabbed_by = $2, grabbed_at = now() where id = (${cell.replace('$2', '0')})`, [groupIds[0], students[0].userId]);
    await sql(`update public.clusters set grabbed_by = $2, grabbed_at = now() where id = (${cell.replace('$2', '1')})`, [groupIds[0], students[1].userId]);
    await sql("update public.members set last_seen = now() - interval '20 seconds' where user_id = $1", [students[1].userId]);
    await sql('update public.members set last_seen = now() where user_id = $1', [students[0].userId]);
    const overview = await rpcOk(teacher1.client, 'session_overview', { p_session: session.id });
    const held = Object.fromEntries(overview.groups[0].clusters.map((c) => [c.pieces[0], c.held_by]));
    expect(held).toEqual({ 0: students[0].userId, 1: null });
  });

  it('수업을 끝내면 상태는 ended, 학생 행은 0개다', async () => {
    const { session } = await startedClass();
    await rpcOk(teacher1.client, 'end_session', { p_session: session.id });
    const overview = await rpcOk(teacher1.client, 'session_overview', { p_session: session.id });
    expect(overview.status).toBe('ended');
    expect(overview.ended_at).not.toBeNull();
    expect(overview.members).toEqual([]);
  });
});
