// Local test teachers for the teacher screens' E2E tests and `pnpm teacher:open`.
// Node only: this file is outside public/, so nothing here is deployed
// (tests/unit/no-test-credentials.test.js checks public/).
//
// The teacher screens sign in with a teacher token of the rt server. Locally there is no
// Google sign-in, so the token comes from the rt server's dev route (pnpm rt:dev; the route
// exists only with test hooks on, never in production) and is put where the page reads it.
//
// These are not the DB tests' teachers (teacher1/2 in supabase/seed.sql): the rt servers
// of tests/server/db restore every open class of the database when they start and count
// them against the per-teacher limit, so the E2E classes must belong to someone else.
// They have no password (nobody signs in as them; only the dev route issues their token).
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { TEACHER_AUTH_KEY } from '../../public/js/teacher/auth.js';

export const LOCAL_TEACHER_ID = '33333333-3333-4333-8333-333333333333';
// "Another teacher" for refusal checks.
export const OTHER_TEACHER_ID = '44444444-4444-4444-8444-444444444444';
// Shown in the teacher bar ('시험용 선생님'); there is no shared profile name.
export const LOCAL_TEACHER_NAME = '시험용';

const LOCAL_TEACHERS = [
  [LOCAL_TEACHER_ID, 'e2e-teacher@jigsaw.test'],
  [OTHER_TEACHER_ID, 'e2e-other@jigsaw.test'],
];

// Adds the two teachers to the local stack when missing (same rows as supabase/seed.sql, for
// stacks seeded before they existed). Local stack only: the DB address comes from
// `pnpm db:status` and must be on this machine.
export async function ensureLocalTeachers() {
  const out = execFileSync('pnpm', ['--silent', 'db:status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const dbUrl = out.match(/^DB_URL="(.*)"$/m)?.[1];
  if (!dbUrl || !/@(127\.0\.0\.1|localhost):/.test(dbUrl)) throw new Error('로컬 Supabase DB 주소를 읽지 못했습니다. `pnpm db:start` 상태를 확인하세요.');
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const [id, email] of LOCAL_TEACHERS) {
      await client.query(
        `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
           email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token,
           reauthentication_token)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(),
           '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', '', '', '', '')
         on conflict (id) do nothing`,
        [id, email],
      );
      await client.query('insert into jigsaw.teachers (id) values ($1) on conflict (id) do nothing', [id]);
    }
  } finally {
    await client.end();
  }
}

export async function devTeacherToken({ rtUrl = 'http://127.0.0.1:3400', origin = 'http://localhost:4173', teacherId = LOCAL_TEACHER_ID } = {}) {
  const res = await fetch(`${rtUrl}/api/dev/teacher-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ teacherId }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.token) throw new Error(`dev teacher token failed: ${res.status} ${body?.error ?? ''}`);
  return body.token;
}

// Arguments for context.addInitScript(): stores the sign-in where public/js/teacher/auth.js
// reads it, before any page script runs.
export function teacherAuthInitScript(token, displayName = LOCAL_TEACHER_NAME) {
  return [
    ([key, value]) => window.localStorage.setItem(key, value),
    [TEACHER_AUTH_KEY, JSON.stringify({ token, displayName })],
  ];
}
