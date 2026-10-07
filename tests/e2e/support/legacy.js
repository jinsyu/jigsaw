// OLD STRUCTURE ONLY (browser -> Supabase): the student screens still join, play and wait
// through Supabase until T22 moves them to the rt server. Their tests (join, play, coop) need
// a class of the old structure, which only a signed-in teacher can open (RPC create_session),
// so the seeded test teacher signs in here with e-mail and password (local stack only).
// The teacher screens no longer use this (T21: rt server, support/teacher.js).
// Remove this file with the old structure (T22/T23).
import { createClient } from '@supabase/supabase-js';
import { pickConfig } from '../../../public/js/config.js';
import { sql } from './teacher.js';

const LOCAL = pickConfig('localhost');
const NODE_CLIENT = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const LEGACY_TEACHER = { email: 'teacher1@jigsaw.test', password: 'local-teacher-only' };

// The seeded teacher signed in to the local Supabase stack: { client, session }.
export async function legacyTeacher() {
  const client = createClient(LOCAL.supabaseUrl, LOCAL.publishableKey, NODE_CLIENT);
  const { data, error } = await client.auth.signInWithPassword(LEGACY_TEACHER);
  if (error) throw error;
  return { client, session: data.session };
}

export async function deleteLegacySessions(ids) {
  if (ids.length) await sql('delete from public.sessions where id = any($1::bigint[])', [ids]);
}
