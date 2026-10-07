// T23 (D12, D14): the old browser-direct structure is gone from the local stack. Only the jigsaw
// schema is ours (core is the seed's stand-in for the shared gyosil profiles): nothing left in
// public, no private RPC schema, no Realtime or Storage policies, no pg_cron, and no anonymous
// sign-in (students make no Supabase account).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { anonClient, cleanup, sql } from './helpers.js';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

afterAll(async () => {
  await cleanup();
});

describe('이전 구조(브라우저 → Supabase 직접)가 남아 있지 않다', () => {
  it('마이그레이션 파일은 jigsaw_ 것만 있고, 로컬 DB 에도 그것만 적용되어 있다', async () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/_jigsaw_/);
    const { rows } = await sql('select version, name from supabase_migrations.schema_migrations order by version');
    expect(rows.map((r) => `${r.version}_${r.name}.sql`)).toEqual(files.sort());
  });

  it('public 스키마에 테이블·뷰·시퀀스·함수가 없다', async () => {
    const { rows: relations } = await sql(
      "select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'",
    );
    expect(relations).toEqual([]);
    const { rows: functions } = await sql(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'",
    );
    expect(functions).toEqual([]);
  });

  it('예전 RPC·정리 작업용 스키마와 pg_cron 이 없다', async () => {
    const { rows: schemas } = await sql(
      "select nspname from pg_namespace where nspname in ('private', 'jigsaw_private', 'cron')",
    );
    expect(schemas).toEqual([]);
    const { rows: extensions } = await sql("select extname from pg_extension where extname = 'pg_cron'");
    expect(extensions).toEqual([]);
  });

  it('Realtime·Storage·public 에 정책이 하나도 없다 (jigsaw-images 는 service_role 전용)', async () => {
    const { rows } = await sql(
      "select schemaname, tablename, policyname from pg_policies where schemaname in ('public', 'realtime', 'storage')",
    );
    expect(rows).toEqual([]);
  });

  it('Realtime 발행 목록에 테이블이 없다', async () => {
    const { rows } = await sql('select pubname, schemaname, tablename from pg_publication_tables');
    expect(rows).toEqual([]);
  });

  it('익명 로그인이 꺼져 있다 (학생은 Supabase 계정을 만들지 않는다)', async () => {
    const { url, anonKey } = inject('supabase');
    const settings = await (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey } })).json();
    expect(settings.external.anonymous_users).toBe(false);
    const { data, error } = await anonClient().auth.signInAnonymously();
    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
    const { rows } = await sql('select count(*)::int as n from auth.users where is_anonymous');
    expect(rows[0].n).toBe(0);
  });
});
