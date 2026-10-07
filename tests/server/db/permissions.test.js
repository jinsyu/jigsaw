// T17 (D12, D14): the jigsaw schema and the jigsaw-images bucket are closed to the publishable
// key (anon) and to signed-in gyosil users (authenticated); only service_role (the rt server)
// gets in. Every table of the schema is checked, so tables added later are covered too.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { TEACHERS, adminClient, anonClient, cleanup, sql, teacherClient } from '../../db/helpers.js';

const BUCKET = 'jigsaw-images';
const EXPECTED_TABLES = ['groups', 'images', 'members', 'schema_migrations', 'sessions', 'teachers'];
// A tiny file that the bucket accepts (type image/webp).
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

let tables = [];
let teacher;
const filePath = `${TEACHERS.one.id}/${randomUUID()}.webp`;

beforeAll(async () => {
  const { rows } = await sql("select tablename from pg_tables where schemaname = 'jigsaw' order by tablename");
  tables = rows.map((r) => r.tablename);
  teacher = await teacherClient(TEACHERS.one);
  const { error } = await adminClient().storage.from(BUCKET).upload(filePath, WEBP, { contentType: 'image/webp' });
  if (error) throw error;
});

afterAll(async () => {
  await adminClient().storage.from(BUCKET).remove([filePath]);
  await cleanup();
});

describe('jigsaw 스키마 구성', () => {
  it('계획한 테이블이 있다', () => {
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it('모든 테이블에 RLS 가 켜져 있고 정책은 하나도 없다', async () => {
    const { rows } = await sql(
      `select c.relname, c.relrowsecurity,
              (select count(*)::int from pg_policies p where p.schemaname = 'jigsaw' and p.tablename = c.relname) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'jigsaw' and c.relkind = 'r' order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(tables);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.policies]).toEqual([r.relname, true, 0]);
  });

  it('학생 이름을 담을 열이 없다 (D14)', async () => {
    const { rows } = await sql(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'jigsaw' and table_name <> 'schema_migrations' and column_name ~* 'name'`,
    );
    expect(rows).toEqual([]);
    const { rows: memberColumns } = await sql(
      "select column_name from information_schema.columns where table_schema = 'jigsaw' and table_name = 'members' order by ordinal_position",
    );
    expect(memberColumns.map((r) => r.column_name)).toEqual(['id', 'session_id', 'group_number', 'color', 'token_hash', 'joined_at']);
  });
});

describe('DB 권한: anon·authenticated 는 아무것도 못 한다 (D12)', () => {
  it('스키마 사용 권한과 모든 테이블·시퀀스·함수 권한이 없다', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await sql('select has_schema_privilege($1, $2, $3) as ok', [role, 'jigsaw', 'usage']);
      expect(rows[0].ok, role).toBe(false);
      for (const t of tables) {
        const { rows: privileges } = await sql(
          `select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i,
                  has_table_privilege($1, $2, 'update') as u, has_table_privilege($1, $2, 'delete') as d`,
          [role, `jigsaw.${t}`],
        );
        expect(privileges[0], `${role} ${t}`).toEqual({ s: false, i: false, u: false, d: false });
      }
    }
    const { rows: grants } = await sql(
      `select 'routine' as kind, routine_name as name, grantee from information_schema.routine_privileges
         where routine_schema = 'jigsaw' and grantee in ('anon', 'authenticated', 'PUBLIC')
       union all
       select 'sequence', object_name, grantee from information_schema.usage_privileges
         where object_schema = 'jigsaw' and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    );
    expect(grants).toEqual([]);
  });

  it('나중에 이 스키마에 만드는 테이블도 처음부터 닫혀 있다 (기본 권한)', async () => {
    const client = new pg.Client({ connectionString: inject('supabase').dbUrl });
    await client.connect();
    try {
      await client.query('begin');
      await client.query('create table jigsaw.probe_default_privileges (x int)');
      const { rows } = await client.query(
        `select has_table_privilege('anon', 'jigsaw.probe_default_privileges', 'select') as anon,
                has_table_privilege('authenticated', 'jigsaw.probe_default_privileges', 'select') as auth`,
      );
      expect(rows[0]).toEqual({ anon: false, auth: false });
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });

  it.each(EXPECTED_TABLES)('REST: 공개 키와 로그인 교사 모두 jigsaw.%s 읽기·쓰기가 거부된다', async (table) => {
    for (const [who, client] of [
      ['anon', anonClient()],
      ['authenticated', teacher.client],
    ]) {
      const read = await client.schema('jigsaw').from(table).select('*').limit(1);
      expect(read.error?.code, `${who} select`).toBe('42501');
      const write = await client.schema('jigsaw').from(table).insert({});
      expect(write.error?.code, `${who} insert`).toBe('42501');
    }
  });

  it('service_role(rt 서버)은 읽고 쓴다', async () => {
    const admin = adminClient().schema('jigsaw');
    for (const table of EXPECTED_TABLES) {
      const { error } = await admin.from(table).select('*').limit(1);
      expect(error, table).toBeNull();
    }
    const { data } = await admin.from('teachers').select('id').order('id');
    expect(data.map((r) => r.id)).toEqual(expect.arrayContaining([TEACHERS.one.id, TEACHERS.two.id]));
    const sessionRow = {
      teacher_id: TEACHERS.one.id,
      code: '000001',
      builtin_key: 'probe',
      piece_count: 12,
      cols: 4,
      rows: 3,
      aspect: 4 / 3,
      seed: 7,
    };
    const inserted = await admin.from('sessions').insert(sessionRow).select('id').single();
    expect(inserted.error).toBeNull();
    const removed = await admin.from('sessions').delete().eq('id', inserted.data.id);
    expect(removed.error).toBeNull();
  });
});

describe('Storage: 비공개 버킷 jigsaw-images (D12)', () => {
  it('버킷은 비공개이고 WebP 3MB 로 제한된다', async () => {
    const { rows } = await sql('select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1', [BUCKET]);
    expect(rows).toEqual([{ public: false, file_size_limit: '3145728', allowed_mime_types: ['image/webp'] }]);
  });

  it('공개 키·로그인 교사는 목록·읽기·서명 URL·올리기·지우기를 못 한다', async () => {
    for (const [who, client] of [
      ['anon', anonClient()],
      ['authenticated', teacher.client],
    ]) {
      const bucket = client.storage.from(BUCKET);
      const listed = await bucket.list(TEACHERS.one.id);
      expect(listed.data ?? [], `${who} list`).toEqual([]);
      expect((await bucket.download(filePath)).error, `${who} download`).toBeTruthy();
      expect((await bucket.createSignedUrl(filePath, 60)).error, `${who} sign`).toBeTruthy();
      const upload = await bucket.upload(`${TEACHERS.one.id}/${randomUUID()}.webp`, WEBP, { contentType: 'image/webp' });
      expect(upload.error, `${who} upload`).toBeTruthy();
      await bucket.remove([filePath]);
      const { rows } = await sql("select count(*)::int as n from storage.objects where bucket_id = $1 and name = $2", [BUCKET, filePath]);
      expect(rows[0].n, `${who} remove`).toBe(1);
      const publicUrl = bucket.getPublicUrl(filePath).data.publicUrl;
      expect((await fetch(publicUrl)).ok, `${who} public url`).toBe(false);
    }
  });

  it('service_role 은 읽고 서명 URL 을 만든다', async () => {
    const bucket = adminClient().storage.from(BUCKET);
    const { data, error } = await bucket.download(filePath);
    expect(error).toBeNull();
    expect(new Uint8Array(await data.arrayBuffer())).toEqual(WEBP);
    const signed = await bucket.createSignedUrl(filePath, 60);
    expect(signed.error).toBeNull();
    expect((await fetch(signed.data.signedUrl)).ok).toBe(true);
  });
});
