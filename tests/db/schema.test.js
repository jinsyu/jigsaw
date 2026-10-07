import { afterAll, describe, expect, it } from 'vitest';
import {
  TEACHERS,
  addMember,
  anonClient,
  cleanup,
  createSessionFixture,
  deleteSessions,
  sql,
  studentClient,
  trackUser,
} from './helpers.js';

const TABLES = ['images', 'sessions', 'groups', 'members', 'clusters', 'pieces'];

async function columnsOf(table) {
  const { rows } = await sql(
    `select column_name, data_type from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
}

afterAll(cleanup);

describe('schema', () => {
  it('members 에 이름 열이 없다 (D14)', async () => {
    const columns = await columnsOf('members');
    expect(Object.keys(columns).sort()).toEqual(
      ['color', 'group_id', 'id', 'joined_at', 'last_seen', 'session_id', 'user_id'].sort(),
    );
  });

  it('public 테이블 어디에도 이름(name) 열이 없다', async () => {
    const { rows } = await sql(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and column_name ilike '%name%'`,
    );
    expect(rows).toEqual([]);
  });

  it('좌표·그림 비율은 float8, 덩어리 id 는 bigint', async () => {
    const clusters = await columnsOf('clusters');
    const sessions = await columnsOf('sessions');
    const pieces = await columnsOf('pieces');
    expect(clusters.x).toBe('double precision');
    expect(clusters.y).toBe('double precision');
    expect(clusters.id).toBe('bigint');
    expect(pieces.cluster_id).toBe('bigint');
    expect(sessions.aspect).toBe('double precision');
    expect(sessions.seed).toBe('bigint');
  });

  it('모든 테이블에 RLS 가 켜져 있다', async () => {
    const { rows } = await sql(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relname = any($1)`,
      [TABLES],
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it('images 버킷은 비공개다', async () => {
    const { rows } = await sql(`select public from storage.buckets where id = 'images'`);
    expect(rows).toEqual([{ public: false }]);
  });

  it('JS 가 계산한 그림 비율·좌표가 DB 를 거쳐도 비트 단위로 같다', async () => {
    const aspects = [4032 / 3024, 1920 / 1081, 3 / 4, 2000 / 1999];
    const student = await studentClient();
    const sessionIds = [];
    try {
      for (const aspect of aspects) {
        const fixture = await createSessionFixture(TEACHERS.one.id, {
          aspect,
          groupCount: 1,
        });
        sessionIds.push(fixture.id);
        const groupId = fixture.groups[0].id;
        await addMember(fixture.id, student.userId, groupId);
        const x = 0.1 + 0.2;
        const y = -1 / 3;
        await sql('update public.clusters set x = $1, y = $2 where group_id = $3', [x, y, groupId]);

        const { data: session, error } = await student.client
          .from('sessions')
          .select('aspect')
          .eq('id', fixture.id)
          .single();
        expect(error).toBeNull();
        expect(Object.is(session.aspect, aspect)).toBe(true);

        const { data: clusters } = await student.client
          .from('clusters')
          .select('x, y')
          .eq('group_id', groupId)
          .limit(1);
        expect(Object.is(clusters[0].x, x)).toBe(true);
        expect(Object.is(clusters[0].y, y)).toBe(true);
      }
    } finally {
      await deleteSessions(sessionIds);
    }
  });

  it('잘못된 그림 비율·격자는 저장되지 않는다', async () => {
    const insert = (aspect, cols, rows) =>
      sql(
        `insert into public.sessions (teacher_id, code, builtin_key, piece_count, cols, rows, aspect, seed)
         values ($1, '000000', 'test-scene', 12, $2, $3, $4, 1)`,
        [TEACHERS.one.id, cols, rows, aspect],
      );
    await expect(insert('NaN', 4, 3)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('Infinity', 4, 3)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(0, 4, 3)).rejects.toMatchObject({ code: '23514' });
    // Portrait picture must use the portrait grid (geometry.gridFor).
    await expect(insert(0.75, 4, 3)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('auth settings', () => {
  it('한 IP 에서 익명 입장 31번 이상이 막히지 않는다 (기본 한도 30 상향)', async () => {
    const results = [];
    for (let i = 0; i < 31; i += 1) {
      const { data, error } = await anonClient().auth.signInAnonymously();
      if (data?.user) trackUser(data.user.id);
      results.push(error?.code ?? 'ok');
    }
    expect(results.filter((r) => r !== 'ok')).toEqual([]);
  });
});
