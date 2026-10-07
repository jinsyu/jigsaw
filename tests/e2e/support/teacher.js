// E2E helpers for teacher screens: the seeded local test teacher (no Google sign-in
// locally), session injection into the page, and direct SQL for cleanup.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { sessionInitScript, signInLocalTeacher } from '../../../scripts/lib/local-teacher.mjs';

let dbUrl = null;
let pool = null;

// DB URL of the local stack, read at run time (`pnpm db:status`), never stored in the repo.
function localDbUrl() {
  if (dbUrl) return dbUrl;
  const out = execFileSync('pnpm', ['--silent', 'db:status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  dbUrl = out.match(/^DB_URL="(.*)"$/m)?.[1];
  if (!dbUrl) throw new Error('로컬 Supabase DB 주소를 읽지 못했습니다. `pnpm db:start` 상태를 확인하세요.');
  return dbUrl;
}

export async function sql(text, params = []) {
  // extra_float_digits = 1: read float8 exactly (the image default 0 rounds to 15 digits).
  pool ??= new pg.Pool({ connectionString: localDbUrl(), max: 2, options: '-c extra_float_digits=1' });
  return pool.query(text, params);
}

export async function closeSql() {
  await pool?.end();
  pool = null;
}

// Signs the seeded teacher in from Node and returns { client, session }.
export function teacherSession() {
  return signInLocalTeacher();
}

// Puts the session where supabase-js in the page looks for it, before any script runs.
export async function signInPage(context) {
  const { client, session } = await teacherSession();
  await context.addInitScript(...sessionInitScript(session));
  return { client, session };
}

export async function deleteSessions(ids) {
  if (ids.length) await sql('delete from jigsaw.sessions where id = any($1::bigint[])', [ids]);
}
