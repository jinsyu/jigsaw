// T4: automatic cleanup (pg_cron job calling jigsaw_private.cleanup_expired) — D14.
// Rows are moved into the past with direct SQL, then the cron function is called directly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEACHERS,
  adminClient,
  cleanup,
  deleteSessions,
  insertImageRow,
  rpcOk,
  sql,
  studentClient,
  teacherClient,
} from './helpers.js';

let teacher;
const sessionIds = [];

async function openSession() {
  const session = await rpcOk(teacher.client, 'create_session', {
    p_piece_count: 12,
    p_group_count: 1,
    p_builtin_key: 'test-scene',
    p_aspect: 1,
  });
  sessionIds.push(session.id);
  return session;
}

async function join(code) {
  const student = await studentClient();
  const result = await rpcOk(student.client, 'join_session', { p_code: code });
  return { ...student, memberId: result.member_id };
}

const runCleanup = async () => (await sql('select jigsaw_private.cleanup_expired() as result')).rows[0].result;
const userExists = async (id) =>
  (await sql('select count(*)::int as n from auth.users where id = $1', [id])).rows[0].n === 1;
const memberExists = async (id) =>
  (await sql('select count(*)::int as n from jigsaw.members where id = $1', [id])).rows[0].n === 1;
const sessionRow = async (id) =>
  (await sql('select status, ended_at from jigsaw.sessions where id = $1', [id])).rows[0];

beforeAll(async () => {
  teacher = await teacherClient(TEACHERS.one);
});

afterAll(async () => {
  await deleteSessions(sessionIds);
  await cleanup();
});

describe('cron 작업', () => {
  it('정리 함수를 매시간 부르는 pg_cron 작업이 있다', async () => {
    const { rows } = await sql(
      "select schedule, command, active from cron.job where jobname = 'jigsaw-cleanup'",
    );
    expect(rows).toEqual([
      { schedule: '17 * * * *', command: 'select jigsaw_private.cleanup_expired()', active: true },
    ]);
  });

  it('API 역할은 정리 함수를 부를 수 없다', async () => {
    const student = await studentClient();
    const { error } = await student.client.schema('jigsaw_private').rpc('cleanup_expired');
    expect(error).toBeTruthy();
    const { rows } = await sql(
      `select has_function_privilege('authenticated', 'jigsaw_private.cleanup_expired()', 'execute') as auth,
              has_function_privilege('anon', 'jigsaw_private.cleanup_expired()', 'execute') as anon`,
    );
    expect(rows[0]).toEqual({ auth: false, anon: false });
  });
});

describe('jigsaw_private.cleanup_expired()', () => {
  it('24시간 지난 members 와 그 익명 계정을 지우고, 최근 들어온 학생은 남긴다', async () => {
    const session = await openSession();
    const old = await join(session.code);
    const fresh = await join(session.code);
    await sql("update jigsaw.members set joined_at = now() - interval '25 hours' where id = $1", [old.memberId]);
    await sql("update auth.users set created_at = now() - interval '25 hours' where id = any($1::uuid[])", [
      [old.userId, fresh.userId],
    ]);

    await runCleanup();
    expect(await memberExists(old.memberId)).toBe(false);
    expect(await userExists(old.userId)).toBe(false);
    // An older device account that joined within 24 hours is still in class: keep it.
    expect(await memberExists(fresh.memberId)).toBe(true);
    expect(await userExists(fresh.userId)).toBe(true);
  });

  it('입장에 실패해 members 가 없는 익명 계정은 24시간 뒤 지운다 (교사 계정은 남김)', async () => {
    const failed = await studentClient();
    const recent = await studentClient();
    await rpcOk(failed.client, 'join_session', { p_code: '000000' });
    await sql("update auth.users set created_at = now() - interval '25 hours' where id = $1", [failed.userId]);
    await sql("update auth.users set created_at = now() - interval '400 days' where id = $1", [TEACHERS.one.id]);

    try {
      await runCleanup();
    } finally {
      await sql("update auth.users set created_at = now() where id = $1", [TEACHERS.one.id]);
    }
    expect(await userExists(failed.userId)).toBe(false);
    expect(await userExists(recent.userId)).toBe(true);
    expect(await userExists(TEACHERS.one.id)).toBe(true);
    const { rows } = await sql('select count(*)::int as n from jigsaw_private.join_failures where user_id = $1', [
      failed.userId,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('종료 30일 지난 수업은 모둠·덩어리·조각과 함께 지우고, 30일 안 된 수업은 남긴다', async () => {
    const expired = await openSession();
    const kept = await openSession();
    const student = await join(expired.code);
    const { rows: groups } = await sql('select id from jigsaw.groups where session_id = $1', [expired.id]);
    await rpcOk(teacher.client, 'assign_member', { p_member: student.memberId, p_group: groups[0].id });
    await rpcOk(teacher.client, 'start_session', { p_session: expired.id });
    await rpcOk(teacher.client, 'end_session', { p_session: expired.id });
    await rpcOk(teacher.client, 'end_session', { p_session: kept.id });
    await sql("update jigsaw.sessions set ended_at = now() - interval '31 days' where id = $1", [expired.id]);
    await sql("update jigsaw.sessions set ended_at = now() - interval '29 days' where id = $1", [kept.id]);

    const result = await runCleanup();
    expect(result.deleted_sessions).toBeGreaterThanOrEqual(1);
    expect(await sessionRow(expired.id)).toBeUndefined();
    expect(await sessionRow(kept.id)).toMatchObject({ status: 'ended' });
    const { rows } = await sql(
      `select (select count(*)::int from jigsaw.groups where session_id = $1) as groups,
              (select count(*)::int from jigsaw.pieces where group_id = $2) as pieces,
              (select count(*)::int from jigsaw.clusters where group_id = $2) as clusters`,
      [expired.id, groups[0].id],
    );
    expect(rows[0]).toEqual({ groups: 0, pieces: 0, clusters: 0 });
  });

  it('24시간 넘게 열려 있던 수업은 끝내고 그 학생 배정을 지운다 (코드가 다시 쓰일 수 있게)', async () => {
    const stale = await openSession();
    const open = await openSession();
    const student = await join(stale.code);
    await sql("update jigsaw.sessions set created_at = now() - interval '25 hours' where id = $1", [stale.id]);

    const result = await runCleanup();
    expect(result.ended_sessions).toBeGreaterThanOrEqual(1);
    expect(await sessionRow(stale.id)).toMatchObject({ status: 'ended' });
    expect((await sessionRow(stale.id)).ended_at).toBeTruthy();
    expect(await memberExists(student.memberId)).toBe(false);
    expect(await sessionRow(open.id)).toMatchObject({ status: 'waiting' });
    // The account itself goes once it is 24 hours old (it has no members row left).
    await sql("update auth.users set created_at = now() - interval '25 hours' where id = $1", [student.userId]);
    await runCleanup();
    expect(await userExists(student.userId)).toBe(false);
  });

  it('교사 그림은 오래 안 써도 자동으로 지우지 않는다', async () => {
    const stale = await insertImageRow(TEACHERS.one.id);
    try {
      await sql("update jigsaw.images set last_used_at = now() - interval '366 days' where id = $1", [stale.id]);
      await runCleanup();
      const { rows: still } = await sql('select count(*)::int as n from jigsaw.images where id = $1', [stale.id]);
      expect(still[0].n).toBe(1);
    } finally {
      await sql('delete from jigsaw.images where id = $1', [stale.id]);
    }
  });
});

// The gyosil project is shared: other services have their own schemas, tables that refer to
// auth.users, and their own anonymous and signed-in users. jigsaw deletes only its students.
describe('공용 프로젝트: 다른 서비스 사용자와 데이터', () => {
  const OTHER = 'othersvc_test';
  const otherUsers = [];

  beforeAll(async () => {
    await sql(`create schema if not exists ${OTHER}`);
    await sql(`create table if not exists ${OTHER}.bookmarks (
      user_id uuid not null references auth.users (id) on delete cascade, note text)`);
    // Without "on delete cascade": the account cannot be deleted while a row refers to it.
    await sql(`create table if not exists ${OTHER}.keepers (user_id uuid not null references auth.users (id))`);
  });

  afterAll(async () => {
    await sql(`drop schema if exists ${OTHER} cascade`);
    if (otherUsers.length) await sql('delete from auth.users where id = any($1::uuid[])', [otherUsers]);
  });

  async function otherServiceUsers() {
    const email = `other-${Date.now()}-${Math.random().toString(36).slice(2)}@othersvc.test`;
    const { data, error } = await adminClient().auth.admin.createUser({ email, password: 'other-service-only', email_confirm: true });
    if (error) throw error;
    otherUsers.push(data.user.id);
    const anon = await studentClient(); // anonymous, but never used jigsaw
    for (const id of [data.user.id, anon.userId]) {
      await sql(`insert into ${OTHER}.bookmarks (user_id, note) values ($1, 'other service row')`, [id]);
    }
    await sql("update auth.users set created_at = now() - interval '400 days' where id = any($1::uuid[])", [
      [data.user.id, anon.userId],
    ]);
    return { signedIn: data.user.id, anonymous: anon.userId };
  }

  const bookmarks = async (id) =>
    (await sql(`select count(*)::int as n from ${OTHER}.bookmarks where user_id = $1`, [id])).rows[0].n;

  it('정리 작업은 다른 서비스의 익명·로그인 사용자를 지우지 않는다 (오래되고 jigsaw 수업에 없어도)', async () => {
    const other = await otherServiceUsers();
    await runCleanup();
    for (const id of [other.signedIn, other.anonymous]) {
      expect(await userExists(id)).toBe(true);
      expect(await bookmarks(id)).toBe(1);
    }
  });

  it('수업 끝내기는 그 수업 학생 계정만 지우고, 그 학생이 다른 서비스에 만든 행만 함께 지워진다', async () => {
    const other = await otherServiceUsers();
    const session = await openSession();
    const student = await join(session.code);
    await sql(`insert into ${OTHER}.bookmarks (user_id, note) values ($1, 'student row')`, [student.userId]);

    await rpcOk(teacher.client, 'end_session', { p_session: session.id });
    expect(await userExists(student.userId)).toBe(false);
    expect(await bookmarks(student.userId)).toBe(0);
    for (const id of [other.signedIn, other.anonymous]) {
      expect(await userExists(id)).toBe(true);
      expect(await bookmarks(id)).toBe(1);
    }
  });

  it('다른 서비스 행이 계정 삭제를 막아도 수업은 끝나고, 정리 작업도 멈추지 않는다', async () => {
    const session = await openSession();
    const student = await join(session.code);
    await sql(`insert into ${OTHER}.keepers (user_id) values ($1)`, [student.userId]);

    const ended = await rpcOk(teacher.client, 'end_session', { p_session: session.id });
    expect(ended.status).toBe('ended');
    expect(await memberExists(student.memberId)).toBe(false);
    expect(await userExists(student.userId)).toBe(true); // kept: the other table still refers to it

    await sql("update auth.users set created_at = now() - interval '25 hours' where id = $1", [student.userId]);
    await expect(runCleanup()).resolves.toBeTruthy();
    expect(await userExists(student.userId)).toBe(true);

    await sql(`delete from ${OTHER}.keepers where user_id = $1`, [student.userId]);
    await runCleanup();
    expect(await userExists(student.userId)).toBe(false);
  });
});
