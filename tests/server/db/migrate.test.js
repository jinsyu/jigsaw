// T17: scripts/db/migrate.sh applies each jigsaw_ migration once, records it in
// jigsaw.schema_migrations, and leaves other apps' schemas alone. It runs against a scratch
// database on the local Supabase Postgres server (stubs for auth.users and storage.buckets),
// so the local stack's own database is not touched.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/db/migrate.sh', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DB_NAME = `jigsaw_migrate_test_${process.pid}`;

let admin;
let scratchUrl;
let scratch;
let tempDir;

function migrate(extraEnv = {}) {
  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      env: { ...process.env, SUPABASE_DB_URL: scratchUrl, ...extraEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

const q = async (text, params) => (await scratch.query(text, params)).rows;

beforeAll(async () => {
  const { dbUrl } = inject('supabase');
  admin = new pg.Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  const url = new URL(dbUrl);
  url.pathname = `/${DB_NAME}`;
  scratchUrl = url.href;
  scratch = new pg.Client({ connectionString: scratchUrl });
  await scratch.connect();
  // What the hosted project already has: auth.users, storage.buckets, and another app.
  await scratch.query(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create schema storage;
    create table storage.buckets (id text primary key, name text not null, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    create schema othersvc;
    create table othersvc.notes (id int primary key, body text);
    insert into othersvc.notes values (1, 'keep me');
    grant usage on schema othersvc to anon;
    grant select on othersvc.notes to anon;
  `);
  tempDir = mkdtempSync(join(tmpdir(), 'jigsaw-migrate-'));
});

afterAll(async () => {
  await scratch?.end();
  await admin?.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin?.end();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('scripts/db/migrate.sh', () => {
  const jigsawFiles = readdirSync(MIGRATIONS).filter((f) => f.includes('jigsaw_')).sort();

  it('SUPABASE_DB_URL 이 없으면 아무것도 하지 않고 멈춘다', () => {
    const run = migrate({ SUPABASE_DB_URL: '' });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('SUPABASE_DB_URL');
  });

  it('jigsaw_ 파일만 이름 순으로 적용하고 schema_migrations 에 기록한다', async () => {
    const run = migrate();
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`완료: 새로 적용 ${jigsawFiles.length}개, 이미 적용 0개`);
    expect(run.stdout + run.stderr).not.toContain(scratchUrl);
    const rows = await q('select name from jigsaw.schema_migrations order by name');
    expect(rows.map((r) => r.name)).toEqual(jigsawFiles.map((f) => f.replace(/\.sql$/, '')));
    const tables = await q("select tablename from pg_tables where schemaname = 'jigsaw' order by 1");
    expect(tables.map((r) => r.tablename)).toEqual(['groups', 'images', 'members', 'schema_migrations', 'sessions', 'teachers']);
    // The old browser-direct migrations (no jigsaw_ in the name) were not applied.
    expect(await q("select to_regclass('public.sessions') as t")).toEqual([{ t: null }]);
  });

  it('두 번째 실행은 아무것도 적용하지 않는다', async () => {
    const before = await q('select name, applied_at from jigsaw.schema_migrations order by name');
    const run = migrate();
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`완료: 새로 적용 0개, 이미 적용 ${jigsawFiles.length}개`);
    expect(await q('select name, applied_at from jigsaw.schema_migrations order by name')).toEqual(before);
  });

  it('다른 앱의 스키마·데이터·권한은 그대로다', async () => {
    expect(await q('select id, body from othersvc.notes')).toEqual([{ id: 1, body: 'keep me' }]);
    expect(await q("select has_table_privilege('anon', 'othersvc.notes', 'select') as ok")).toEqual([{ ok: true }]);
    expect(await q("select id, public from storage.buckets")).toEqual([{ id: 'jigsaw-images', public: false }]);
  });

  it('실패한 파일은 통째로 되돌려지고 기록되지 않으며, 다음 실행에서 다시 시도된다', async () => {
    for (const f of jigsawFiles) copyFileSync(join(MIGRATIONS, f), join(tempDir, f));
    const bad = '29990101000000_jigsaw_probe_fail';
    writeFileSync(join(tempDir, `${bad}.sql`), 'create table jigsaw.probe_half (x int);\nselect 1 / 0;\n');
    const run = migrate({ JIGSAW_MIGRATIONS_DIR: tempDir });
    expect(run.code).not.toBe(0);
    expect(await q("select to_regclass('jigsaw.probe_half') as t")).toEqual([{ t: null }]);
    expect(await q('select count(*)::int as n from jigsaw.schema_migrations where name = $1', [bad])).toEqual([{ n: 0 }]);

    writeFileSync(join(tempDir, `${bad}.sql`), 'create table jigsaw.probe_half (x int);\n');
    const retry = migrate({ JIGSAW_MIGRATIONS_DIR: tempDir });
    expect(retry.code, retry.stderr).toBe(0);
    expect(retry.stdout).toContain('새로 적용 1개');
  });

  it('이름 형식이 다른 jigsaw_ 파일이 있으면 멈춘다', () => {
    const odd = mkdtempSync(join(tmpdir(), 'jigsaw-migrate-odd-'));
    try {
      writeFileSync(join(odd, '2026_jigsaw_Bad Name.sql'), 'select 1;');
      const run = migrate({ JIGSAW_MIGRATIONS_DIR: odd });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('이름 형식');
    } finally {
      rmSync(odd, { recursive: true, force: true });
    }
  });
});
