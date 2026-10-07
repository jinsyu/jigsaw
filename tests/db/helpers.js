// Shared helpers for DB tests: clients per role, direct SQL, fixtures, cleanup.
import { randomInt, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { inject } from 'vitest';
import { gridFor } from '../../public/js/puzzle/geometry.js';

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
const createdUsers = new Set();
const openClients = new Set();
const openDbClients = new Set();

export function anonClient() {
  const client = createClient(env().url, env().anonKey, CLIENT_OPTIONS);
  openClients.add(client);
  return client;
}

export function adminClient() {
  const client = createClient(env().url, env().serviceKey, CLIENT_OPTIONS);
  openClients.add(client);
  return client;
}

export async function teacherClient(teacher = TEACHERS.one) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: teacher.email,
    password: TEACHER_PASSWORD,
  });
  if (error) throw error;
  await client.realtime.setAuth(data.session.access_token);
  return { client, userId: data.user.id };
}

// An anonymous student account. Deleted again by cleanupUsers().
export async function studentClient() {
  const client = anonClient();
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  createdUsers.add(data.user.id);
  await client.realtime.setAuth(data.session.access_token);
  return { client, userId: data.user.id };
}

export function trackUser(userId) {
  createdUsers.add(userId);
}

export async function sql(text, params = []) {
  // extra_float_digits = 1: read float8 back exactly (the image default 0 rounds to 15 digits).
  pool ??= new pg.Pool({ connectionString: env().dbUrl, max: 2, options: '-c extra_float_digits=1' });
  return pool.query(text, params);
}

// A dedicated connection (for tests that hold a transaction open while another one runs).
export async function dbClient() {
  const client = new pg.Client({ connectionString: env().dbUrl, options: '-c extra_float_digits=1' });
  await client.connect();
  openDbClients.add(client);
  return client;
}

// Starts a transaction on `client` that runs as the given anonymous student, the way
// PostgREST would (role authenticated + JWT claims), so RPCs see auth.uid().
export async function beginAsStudent(client, userId) {
  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: 'authenticated', is_anonymous: true }),
  ]);
}

async function insertSession(teacherId, { pieceCount, aspect, imageId }) {
  const { cols, rows } = gridFor(pieceCount, aspect);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      const { rows: inserted } = await sql(
        `insert into public.sessions (teacher_id, code, image_id, builtin_key, piece_count, cols, rows, aspect, seed)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [
          teacherId,
          code,
          imageId,
          imageId ? null : 'test-scene',
          pieceCount,
          cols,
          rows,
          aspect,
          randomInt(1, 2 ** 32),
        ],
      );
      return inserted[0];
    } catch (error) {
      if (error.code !== '23505') throw error; // code already used by an open session
    }
  }
  throw new Error('could not pick a free session code');
}

// One cluster per piece, laid out in picture order (x = col * 100 + 10 * index).
async function insertPuzzle(groupId, cols, rows) {
  const pieces = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const { rows: cluster } = await sql(
        'insert into public.clusters (group_id, x, y) values ($1, $2, $3) returning id',
        [groupId, col * 100, row * 100],
      );
      await sql(
        'insert into public.pieces (group_id, col, "row", cluster_id) values ($1, $2, $3, $4)',
        [groupId, col, row, cluster[0].id],
      );
      pieces.push({ col, row, clusterId: Number(cluster[0].id) });
    }
  }
  return pieces;
}

// A session with groups and a full puzzle per group, written directly (no RPC yet).
export async function createSessionFixture(
  teacherId,
  { pieceCount = 12, groupCount = 2, aspect = 4 / 3, imageId = null } = {},
) {
  const session = await insertSession(teacherId, { pieceCount, aspect, imageId });
  const groups = [];
  for (let number = 1; number <= groupCount; number += 1) {
    const { rows } = await sql(
      'insert into public.groups (session_id, number) values ($1, $2) returning id',
      [session.id, number],
    );
    const id = Number(rows[0].id);
    groups.push({ id, number, pieces: await insertPuzzle(id, session.cols, session.rows) });
  }
  return { id: Number(session.id), session, groups };
}

export async function addMember(sessionId, userId, groupId = null, color = null) {
  const { rows } = await sql(
    `insert into public.members (session_id, user_id, group_id, color)
     values ($1, $2, $3, $4) returning id`,
    [sessionId, userId, groupId, color],
  );
  return Number(rows[0].id);
}

export async function insertImageRow(teacherId, { width = 1600, height = 1200 } = {}) {
  const id = randomUUID();
  const { rows } = await sql(
    'insert into public.images (id, teacher_id, width, height) values ($1, $2, $3, $4) returning *',
    [id, teacherId, width, height],
  );
  return rows[0];
}

export async function deleteSessions(ids) {
  if (ids.length) await sql('delete from public.sessions where id = any($1::bigint[])', [ids]);
}

// Subscribes to a Realtime channel and resolves with the join outcome.
// status: 'SUBSCRIBED' on success, 'CHANNEL_ERROR' / 'TIMED_OUT' when refused.
export function subscribe(client, topic, { isPrivate = true, presenceKey } = {}) {
  const received = [];
  const config = { private: isPrivate, broadcast: { self: false } };
  if (presenceKey) config.presence = { key: presenceKey };
  const channel = client.channel(topic, { config });
  channel.on('broadcast', { event: '*' }, (message) => received.push(message));
  if (presenceKey) channel.on('presence', { event: 'sync' }, () => {});
  return new Promise((resolve) => {
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') resolve({ channel, status, error, received });
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // Stop the client from retrying a refused join (leaving waits for a reply; do not block on it).
        client.removeChannel(channel).catch(() => {});
        resolve({ channel, status, error, received });
      }
    });
  });
}

// Right after the stack starts, Realtime opens its database stream lazily on the first
// private join, so the first messages can be missed. Sends a 'warmup' broadcast until the
// subscription sees it, then drops the warm-up messages from `received`.
export async function warmUp(subscription, topic) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sql("select realtime.send('{}'::jsonb, 'warmup', $1, true)", [topic]);
    const seen = await waitFor(
      () => subscription.received.some((m) => m.event === 'warmup'),
      { timeout: 1000 },
    );
    if (seen) break;
  }
  await sleep(200);
  const rest = subscription.received.filter((m) => m.event !== 'warmup');
  subscription.received.splice(0, subscription.received.length, ...rest);
}

// Calls an RPC and throws on error (for setup steps that must succeed).
export async function rpcOk(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.code} ${error.message}`);
  return data;
}

// Leaves every channel on every client (call between tests so a topic can be joined again).
export async function leaveAllChannels() {
  for (const client of openClients) await client.removeAllChannels();
}

export async function waitFor(check, { timeout = 5000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Disconnects clients, deletes anonymous test users and closes the SQL pool.
export async function cleanup() {
  await leaveAllChannels();
  for (const client of openClients) client.realtime.disconnect();
  openClients.clear();
  if (createdUsers.size) {
    await sql('delete from auth.users where id = any($1::uuid[]) and is_anonymous', [
      [...createdUsers],
    ]);
    createdUsers.clear();
  }
  for (const client of openDbClients) await client.end().catch(() => {});
  openDbClients.clear();
  await pool?.end();
  pool = null;
}
