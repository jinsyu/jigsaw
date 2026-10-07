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
     where table_schema = 'jigsaw' and table_name = $1 order by ordinal_position`,
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

  it('jigsaw 테이블 어디에도 이름(name) 열이 없다', async () => {
    const { rows } = await sql(
      `select table_name, column_name from information_schema.columns
       where table_schema in ('jigsaw', 'jigsaw_private') and column_name ilike '%name%'`,
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
       where relnamespace = 'jigsaw'::regnamespace and relname = any($1)`,
      [TABLES],
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it('jigsaw-images 버킷은 비공개다', async () => {
    const { rows } = await sql(`select public from storage.buckets where id = 'jigsaw-images'`);
    expect(rows).toEqual([{ public: false }]);
  });

  // The shared project keeps the image default extra_float_digits = 0 (no role settings), so
  // a plain select rounds float8 to 15 digits; the screens read through session_setup and
  // load_board, which print float8 exactly.
  it('JS 가 계산한 그림 비율·좌표가 DB 를 거쳐도 비트 단위로 같다 (session_setup·load_board)', async () => {
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
        await sql('update jigsaw.clusters set x = $1, y = $2 where group_id = $3', [x, y, groupId]);

        const { data: session, error } = await student.client.rpc('session_setup', { p_session: fixture.id });
        expect(error).toBeNull();
        expect(Object.is(session.aspect, aspect)).toBe(true);

        const { data: board, error: boardError } = await student.client.rpc('load_board', { p_group: groupId });
        expect(boardError).toBeNull();
        expect(board.clusters.length).toBeGreaterThan(0);
        for (const c of board.clusters) {
          expect(Object.is(c.x, x)).toBe(true);
          expect(Object.is(c.y, y)).toBe(true);
        }
      }
      // A plain select is not exact (0.1 + 0.2 needs 17 digits): role settings are untouched.
      const { data: plain } = await student.client.from('clusters').select('x').limit(1);
      expect(plain[0].x).toBe(0.3);
    } finally {
      await deleteSessions(sessionIds);
    }
  });

  it('잘못된 그림 비율·격자는 저장되지 않는다', async () => {
    const insert = (aspect, cols, rows) =>
      sql(
        `insert into jigsaw.sessions (teacher_id, code, builtin_key, piece_count, cols, rows, aspect, seed)
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

// gyosil is one Supabase project shared by several services: jigsaw keeps to its own schemas
// and jigsaw-named entries in shared tables, and changes no role or database setting.
describe('공용 프로젝트(gyosil) 규칙', () => {
  it('API 역할에 extra_float_digits 같은 역할 설정을 걸지 않는다', async () => {
    const { rows } = await sql(
      `select r.rolname, s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
       where array_to_string(s.setconfig, ',') ilike '%extra_float_digits%'`,
    );
    expect(rows).toEqual([]);
  });

  it('공용 테이블(realtime.messages, storage.objects)의 jigsaw 정책은 이름이 jigsaw_ 로 시작하고 jigsaw 대상만 본다', async () => {
    const { rows } = await sql(
      `select schemaname, tablename, policyname, coalesce(qual, '') || coalesce(with_check, '') as rule
       from pg_policies where schemaname in ('realtime', 'storage')`,
    );
    const ours = rows.filter((r) => r.rule.includes('jigsaw_private.'));
    expect(ours.map((r) => r.policyname).sort()).toEqual([
      'jigsaw_delete_own_files_not_in_open_class',
      'jigsaw_read_own_files_or_session_image',
      'jigsaw_receive_group_and_session_topics',
      'jigsaw_teachers_upload_own_folder',
      'jigsaw_track_presence_on_session_topic',
    ]);
    for (const r of ours) {
      if (r.tablename === 'messages') expect(r.rule).toContain("'jigsaw:%'");
      else expect(r.rule).toContain("bucket_id = 'jigsaw-images'");
    }
  });

  it('jigsaw_private 는 anon 에 열리지 않고, 정책에 쓰는 함수만 authenticated 가 실행할 수 있다', async () => {
    const { rows: usage } = await sql(
      `select has_schema_privilege('anon', 'jigsaw_private', 'usage') as anon,
              has_schema_privilege('anon', 'jigsaw', 'usage') as anon_api`,
    );
    expect(usage[0]).toEqual({ anon: false, anon_api: true });
    const { rows } = await sql(
      `select p.proname from pg_proc p
       where p.pronamespace = 'jigsaw_private'::regnamespace
         and has_function_privilege('authenticated', p.oid, 'execute')
       order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      'can_access_group',
      'can_access_session',
      'can_join_topic',
      'can_read_image_object',
      'can_track_presence',
      'image_in_open_session',
      'image_object_in_open_session',
      'image_used_by_my_session',
      'is_group_member',
      'is_group_teacher',
      'is_session_member',
      'is_session_teacher',
      'is_teacher',
    ]);
  });

  it('Data API 로는 jigsaw 스키마만 보이고 jigsaw_private 는 부를 수 없다', async () => {
    const student = await studentClient();
    const { error } = await student.client.schema('jigsaw_private').rpc('is_teacher');
    expect(error).toBeTruthy();
    const { error: ok } = await student.client.from('sessions').select('id').limit(1);
    expect(ok).toBeNull();
  });
});
