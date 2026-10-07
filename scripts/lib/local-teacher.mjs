// Seeded local test teacher (supabase/seed.sql) for E2E tests and local dev tools.
// Node only: this file is outside public/ so the credentials are never deployed
// (tests/unit/no-test-credentials.test.js checks public/).
import { createClient } from '@supabase/supabase-js';
import { pickConfig } from '../../public/js/config.js';
import { TEACHER_AUTH_KEY } from '../../public/js/supabase-client.js';

export const LOCAL_TEACHER = { email: 'teacher1@jigsaw.test', password: 'local-teacher-only' };
export { TEACHER_AUTH_KEY };

const LOCAL = pickConfig('localhost');
const NODE_CLIENT = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

// Signs the test teacher in against the local stack. Returns { client, session }.
export async function signInLocalTeacher() {
  const client = createClient(LOCAL.supabaseUrl, LOCAL.publishableKey, NODE_CLIENT);
  const { data, error } = await client.auth.signInWithPassword(LOCAL_TEACHER);
  if (error) throw error;
  return { client, session: data.session };
}

// Script for context.addInitScript(): stores the session where the page's supabase-js reads it.
export function sessionInitScript(session) {
  return [
    ([key, value]) => window.localStorage.setItem(key, value),
    [TEACHER_AUTH_KEY, JSON.stringify(session)],
  ];
}

// New structure (T20): a teacher token for the seeded teacher from the local rt server's dev
// route (pnpm rt:dev; the route exists only with test hooks on, never in production). The
// teacher screens switch to it in T21; the Supabase sign-in above stays until then.
export const LOCAL_TEACHER_ID = '11111111-1111-4111-8111-111111111111';

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
