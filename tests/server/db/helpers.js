// Shared helpers for the tests against the local Supabase stack: clients per role (to check
// what the publishable key and a signed-in gyosil user cannot reach), direct SQL, cleanup.
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { inject } from 'vitest';

// Seeded local test teachers (supabase/seed.sql). Local stack only.
export const TEACHERS = {
  one: { id: '11111111-1111-4111-8111-111111111111', email: 'teacher1@jigsaw.test' },
  two: { id: '22222222-2222-4222-8222-222222222222', email: 'teacher2@jigsaw.test' },
};
const TEACHER_PASSWORD = 'local-teacher-only';

const CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

const env = () => inject('supabase');

let pool = null;

export function anonClient() {
  return createClient(env().url, env().anonKey, CLIENT_OPTIONS);
}

export function adminClient() {
  return createClient(env().url, env().serviceKey, CLIENT_OPTIONS);
}

// A signed-in gyosil user (role authenticated) with the publishable key.
export async function teacherClient(teacher = TEACHERS.one) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: teacher.email,
    password: TEACHER_PASSWORD,
  });
  if (error) throw error;
  return { client, userId: data.user.id };
}

export async function sql(text, params = []) {
  // extra_float_digits = 1: read float8 back exactly (the default 0 rounds to 15 digits).
  pool ??= new pg.Pool({ connectionString: env().dbUrl, max: 2, options: '-c extra_float_digits=1' });
  return pool.query(text, params);
}

// Closes the SQL pool.
export async function cleanup() {
  await pool?.end();
  pool = null;
}
