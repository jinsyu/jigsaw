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
