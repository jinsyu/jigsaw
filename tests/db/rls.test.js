// D12: students read only their own session and group; nobody writes puzzle tables directly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEACHERS,
  addMember,
  anonClient,
  cleanup,
  createSessionFixture,
  deleteSessions,
  insertImageRow,
  sql,
  studentClient,
  teacherClient,
} from './helpers.js';

const PERMISSION_DENIED = '42501';

let sessionA; // teacher one: groups A1, A2
let sessionB; // teacher two: group B1
let a1;
let a2;
let b1;
let s1; // A1
let s5; // A1 (groupmate of s1)
let s2; // A2
let s3; // B1 (other session)
let s4; // session A, not assigned yet
let teacher1;
let teacher2;
let imageA;

const idsOf = (rows) => rows.map((r) => Number(r.id)).sort((x, y) => x - y);
const sorted = (ids) => [...ids].sort((x, y) => x - y);
const clusterIdsOf = (group) => sorted(group.pieces.map((p) => p.clusterId));

beforeAll(async () => {
  imageA = await insertImageRow(TEACHERS.one.id);
  sessionA = await createSessionFixture(TEACHERS.one.id, { groupCount: 2, imageId: imageA.id });
  sessionB = await createSessionFixture(TEACHERS.two.id, { groupCount: 1 });
  [a1, a2] = sessionA.groups;
  [b1] = sessionB.groups;

  [s1, s5, s2, s3, s4] = await Promise.all([1, 2, 3, 4, 5].map(() => studentClient()));
  await addMember(sessionA.id, s1.userId, a1.id, 0);
  await addMember(sessionA.id, s5.userId, a1.id, 1);
  await addMember(sessionA.id, s2.userId, a2.id, 0);
  await addMember(sessionB.id, s3.userId, b1.id, 0);
  await addMember(sessionA.id, s4.userId, null, null);

  teacher1 = await teacherClient(TEACHERS.one);
  teacher2 = await teacherClient(TEACHERS.two);
});

afterAll(async () => {
  await deleteSessions([sessionA?.id, sessionB?.id].filter(Boolean));
  if (imageA) await sql('delete from public.images where id = $1', [imageA.id]);
  await cleanup();
});

describe('학생 읽기', () => {
  it('자기 수업 행만 읽는다', async () => {
    const { data, error } = await s1.client.from('sessions').select('id');
    expect(error).toBeNull();
    expect(idsOf(data)).toEqual([sessionA.id]);
  });

  it('자기 모둠 행만 읽는다 (같은 수업 다른 모둠도 안 보임)', async () => {
    const { data } = await s1.client.from('groups').select('id');
    expect(idsOf(data)).toEqual([a1.id]);
  });

  it('members 는 자기와 같은 모둠 친구만 읽는다', async () => {
    const { data } = await s1.client.from('members').select('user_id');
    expect(data.map((r) => r.user_id).sort()).toEqual([s1.userId, s5.userId].sort());
  });

  it('덩어리·조각은 자기 모둠 것만 읽는다', async () => {
    const { data: clusters } = await s1.client.from('clusters').select('id');
    expect(idsOf(clusters)).toEqual(clusterIdsOf(a1));
    const { data: pieces } = await s1.client.from('pieces').select('group_id');
    expect(new Set(pieces.map((p) => Number(p.group_id)))).toEqual(new Set([a1.id]));
    expect(pieces).toHaveLength(a1.pieces.length);
  });

  it('다른 모둠·다른 수업 행을 콕 집어 요청해도 빈 결과다', async () => {
    for (const groupId of [a2.id, b1.id]) {
      const { data: g } = await s1.client.from('groups').select('id').eq('id', groupId);
      const { data: c } = await s1.client.from('clusters').select('id').eq('group_id', groupId);
      const { data: p } = await s1.client.from('pieces').select('col').eq('group_id', groupId);
      expect([g, c, p]).toEqual([[], [], []]);
    }
    const { data: otherSession } = await s1.client.from('sessions').select('id').eq('id', sessionB.id);
    expect(otherSession).toEqual([]);
    const { data: otherMembers } = await s1.client
      .from('members')
      .select('user_id')
      .in('user_id', [s2.userId, s3.userId, s4.userId]);
    expect(otherMembers).toEqual([]);
  });

  it('모둠 배정 전 학생은 자기 수업·자기 행만 보고 모둠 데이터는 못 본다', async () => {
    const { data: sessions } = await s4.client.from('sessions').select('id');
    expect(idsOf(sessions)).toEqual([sessionA.id]);
    const { data: members } = await s4.client.from('members').select('user_id');
    expect(members.map((m) => m.user_id)).toEqual([s4.userId]);
    const { data: groups } = await s4.client.from('groups').select('id');
    const { data: clusters } = await s4.client.from('clusters').select('id');
    expect([groups, clusters]).toEqual([[], []]);
  });

  it('수업에 들어가지 않은 익명 사용자는 아무것도 못 읽는다', async () => {
    const stranger = await studentClient();
    for (const table of ['sessions', 'groups', 'members', 'clusters', 'pieces', 'images']) {
      const { data, error } = await stranger.client.from(table).select('*');
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
    }
  });

  it('로그인하지 않은 요청(anon 키)은 거부된다', async () => {
    const { error } = await anonClient().from('sessions').select('id');
    expect(error?.code).toBe(PERMISSION_DENIED);
  });
});

describe('교사 읽기', () => {
  it('자기 수업과 그 모둠·학생·조각 전체를 읽는다', async () => {
    const { client } = teacher1;
    const { data: sessions } = await client.from('sessions').select('id');
    expect(idsOf(sessions)).toEqual([sessionA.id]);
    const { data: groups } = await client.from('groups').select('id');
    expect(idsOf(groups)).toEqual(sorted([a1.id, a2.id]));
    const { data: members } = await client.from('members').select('user_id');
    expect(members.map((m) => m.user_id).sort()).toEqual(
      [s1.userId, s5.userId, s2.userId, s4.userId].sort(),
    );
    const { data: clusters } = await client.from('clusters').select('id');
    expect(idsOf(clusters)).toEqual(sorted([...clusterIdsOf(a1), ...clusterIdsOf(a2)]));
  });

  it('다른 교사의 수업은 읽지 못한다', async () => {
    const { client } = teacher2;
    const { data: sessions } = await client.from('sessions').select('id').eq('id', sessionA.id);
    const { data: groups } = await client.from('groups').select('id').in('id', [a1.id, a2.id]);
    const { data: members } = await client.from('members').select('id').eq('session_id', sessionA.id);
    const { data: clusters } = await client.from('clusters').select('id').eq('group_id', a1.id);
    expect([sessions, groups, members, clusters]).toEqual([[], [], [], []]);
  });
});

describe('직접 쓰기 거부 (RPC 만 허용)', () => {
  it('학생이 자기 모둠 덩어리를 직접 update 하면 거부되고 값이 그대로다', async () => {
    const clusterId = a1.pieces[0].clusterId;
    const before = await sql('select x, y, grabbed_by from public.clusters where id = $1', [clusterId]);
    const { error } = await s1.client.from('clusters').update({ x: 999, grabbed_by: s1.userId }).eq('id', clusterId);
    expect(error?.code).toBe(PERMISSION_DENIED);
    const after = await sql('select x, y, grabbed_by from public.clusters where id = $1', [clusterId]);
    expect(after.rows).toEqual(before.rows);
  });

  it('학생이 조각 상자 주인·판 위 여부를 직접 바꾸지 못한다', async () => {
    const { error } = await s1.client
      .from('pieces')
      .update({ owner_id: s1.userId, on_board: true })
      .eq('group_id', a1.id);
    expect(error?.code).toBe(PERMISSION_DENIED);
    const { rows } = await sql(
      'select count(*)::int as n from public.pieces where group_id = $1 and (owner_id is not null or on_board)',
      [a1.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('학생이 다른 모둠 행에 쓰기(insert·update·delete)를 하면 거부된다', async () => {
    const insert = await s1.client.from('clusters').insert({ group_id: a2.id, x: 1, y: 1 });
    const update = await s1.client.from('clusters').update({ x: 5 }).eq('group_id', b1.id);
    const remove = await s1.client.from('pieces').delete().eq('group_id', a2.id);
    expect([insert.error?.code, update.error?.code, remove.error?.code]).toEqual([
      PERMISSION_DENIED,
      PERMISSION_DENIED,
      PERMISSION_DENIED,
    ]);
    const { rows } = await sql('select count(*)::int as n from public.pieces where group_id = $1', [a2.id]);
    expect(rows[0].n).toBe(a2.pieces.length);
  });

  it('학생이 자기 모둠을 바꾸거나 수업에 스스로 들어가지 못한다', async () => {
    const move = await s1.client.from('members').update({ group_id: a2.id }).eq('user_id', s1.userId);
    const join = await s3.client.from('members').insert({ session_id: sessionA.id, user_id: s3.userId });
    expect([move.error?.code, join.error?.code]).toEqual([PERMISSION_DENIED, PERMISSION_DENIED]);
    const { rows } = await sql('select group_id from public.members where user_id = $1', [s1.userId]);
    expect(rows.map((r) => Number(r.group_id))).toEqual([a1.id]);
  });

  it('학생이 완성 시각·수업 상태를 직접 바꾸지 못한다', async () => {
    const group = await s1.client.from('groups').update({ completed_at: new Date().toISOString() }).eq('id', a1.id);
    const session = await s1.client.from('sessions').update({ status: 'ended' }).eq('id', sessionA.id);
    expect([group.error?.code, session.error?.code]).toEqual([PERMISSION_DENIED, PERMISSION_DENIED]);
  });

  it('교사도 수업·덩어리 테이블을 직접 바꾸지 못한다', async () => {
    const session = await teacher1.client.from('sessions').update({ status: 'ended' }).eq('id', sessionA.id);
    const clusters = await teacher1.client.from('clusters').delete().eq('group_id', a1.id);
    expect([session.error?.code, clusters.error?.code]).toEqual([PERMISSION_DENIED, PERMISSION_DENIED]);
    const { rows } = await sql('select status from public.sessions where id = $1', [sessionA.id]);
    expect(rows[0].status).toBe('waiting');
  });
});

describe('images 행', () => {
  it('교사는 자기 그림 행을 추가·삭제하고, 경로는 <교사 uid>/<id>.webp 로 정해진다', async () => {
    const id = crypto.randomUUID();
    const { data, error } = await teacher1.client
      .from('images')
      .insert({ id, width: 2000, height: 1500 })
      .select('teacher_id, path')
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ teacher_id: TEACHERS.one.id, path: `${TEACHERS.one.id}/${id}.webp` });
    const removed = await teacher1.client.from('images').delete().eq('id', id).select('id');
    expect(removed.data).toHaveLength(1);
  });

  it('다른 교사 이름으로 넣거나, 학생이 넣으면 거부된다', async () => {
    const forged = await teacher1.client
      .from('images')
      .insert({ teacher_id: TEACHERS.two.id, width: 10, height: 10 });
    const byStudent = await s1.client.from('images').insert({ teacher_id: s1.userId, width: 10, height: 10 });
    expect([forged.error?.code, byStudent.error?.code]).toEqual([PERMISSION_DENIED, PERMISSION_DENIED]);
  });

  it('긴 변이 2000px 를 넘는 그림 행은 저장되지 않는다', async () => {
    const { error } = await teacher1.client.from('images').insert({ width: 2001, height: 1000 });
    expect(error?.code).toBe('23514');
  });

  it('다른 교사는 그림 행을 읽거나 지우지 못한다', async () => {
    const { data } = await teacher2.client.from('images').select('id').eq('id', imageA.id);
    expect(data).toEqual([]);
    const removed = await teacher2.client.from('images').delete().eq('id', imageA.id).select('id');
    expect(removed.data ?? []).toEqual([]);
    const { rows } = await sql('select count(*)::int as n from public.images where id = $1', [imageA.id]);
    expect(rows[0].n).toBe(1);
  });

  it('학생은 자기 수업이 쓰는 그림 행만 읽는다', async () => {
    const mine = await s1.client.from('images').select('id');
    expect(mine.data.map((r) => r.id)).toEqual([imageA.id]);
    const other = await s3.client.from('images').select('id');
    expect(other.data).toEqual([]);
  });
});
