// T20 (D1, D2, D12): teacher sign-in and 함께 퍼즐 시작하기, classes and pictures over HTTP,
// on an in-process rt server with a fake Google check (the real one is tried in T25).
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { startServer } from '../../../server/src/index.js';
import { signTeacherToken } from '../../../server/src/teacher-token.js';
import { TEACHERS, adminClient, cleanup, sql } from './helpers.js';

const ORIGIN = 'http://localhost:4173';
const SECRET = 'teacher-api-test-secret-'.padEnd(48, 'x');
const NONCE = 'raw-nonce-1';
const WEBP = readFileSync(new URL('../../../public/images/builtin/sea.webp', import.meta.url));

let server;
let base;
const quiet = { info: () => {}, error: () => {} };
const createdUsers = [];
const createdSessions = new Set();
const createdImages = new Set();
const sockets = [];

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Fake Google check: "google:<uid>" with the right nonce.
async function fakeVerify({ idToken, nonce }) {
  if (nonce !== NONCE || !idToken.startsWith('google:')) throw new Error('bad token');
  return { uid: idToken.slice('google:'.length), email: null };
}

async function boot(extraEnv = {}) {
  const env = inject('supabase');
  const port = await freePort();
  return startServer({
    env: {
      NODE_ENV: 'test',
      PORT: String(port),
      SUPABASE_URL: env.url,
      SUPABASE_SERVICE_ROLE_KEY: env.serviceKey,
      SUPABASE_ANON_KEY: env.anonKey,
      SESSION_SECRET: SECRET,
      ALLOWED_ORIGINS: ORIGIN,
      RT_TEST_HOOKS: '1',
      ...extraEnv,
    },
    log: quiet,
    proc: new EventEmitter(),
    verifyIdToken: fakeVerify,
  });
}

async function call(method, path, { body, token, type = 'application/json', raw, origin = ORIGIN, root = base } = {}) {
  const headers = { origin };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['content-type'] = type;
  const res = await fetch(`${root}${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const tokenOf = (teacher) => signTeacherToken(teacher.id, SECRET);

async function newAccount() {
  const { data, error } = await adminClient().auth.admin.createUser({
    email: `t20-${randomUUID()}@jigsaw.test`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error) throw error;
  createdUsers.push(data.user.id);
  return data.user.id;
}

async function openClass(token, picture = { builtinKey: 'sea' }) {
  const res = await call('POST', '/api/sessions', { token, body: { pieceCount: 12, groupCount: 2, picture } });
  if (res.status === 200) createdSessions.add(res.body.sessionId);
  return res;
}

async function upload(token, bytes = WEBP) {
  const res = await call('POST', '/api/images', { token, raw: bytes, type: 'image/webp' });
  if (res.status === 200) createdImages.add(res.body.image.id);
  return res;
}

function socketOf(auth) {
  const s = connect(base, { auth, transports: ['websocket'], extraHeaders: { origin: ORIGIN }, forceNew: true });
  sockets.push(s);
  return s;
}

const firstState = (s) =>
  new Promise((resolve, reject) => {
    s.once('state', resolve);
    s.once('connect_error', reject);
  });

beforeAll(async () => {
  server = await boot();
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await server?.close();
  if (createdSessions.size) await sql('delete from jigsaw.sessions where id = any($1::uuid[])', [[...createdSessions]]);
  if (createdImages.size) {
    const { rows } = await sql('select path from jigsaw.images where id = any($1::uuid[])', [[...createdImages]]);
    if (rows.length) await adminClient().storage.from('jigsaw-images').remove(rows.map((r) => r.path));
    await sql('delete from jigsaw.images where id = any($1::uuid[])', [[...createdImages]]);
  }
  if (createdUsers.length) {
    await sql('delete from core.profiles where id = any($1::uuid[])', [createdUsers]);
    await sql('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
  }
  await cleanup();
});

describe('교사 로그인·함께 퍼즐 시작하기 (D1)', () => {
  it('처음 온 계정은 시작하기를 거쳐 teachers 행과 공용 프로필을 만들고 교사 토큰을 받는다', async () => {
    const uid = await newAccount();
    const first = await call('POST', '/api/teacher/login', { body: { idToken: `google:${uid}`, nonce: NONCE } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, needsStart: true, profile: { displayName: null } });
    expect(first.body.token).toBeUndefined();
    const ticket = first.body.startTicket;

    expect((await call('POST', '/api/teacher/start', { body: { startTicket: ticket, displayName: '김선생' } })).body.error).toBe('terms_required');
    expect((await call('POST', '/api/teacher/start', { body: { startTicket: ticket, displayName: ' ​ ', agreed: true } })).body.error).toBe('invalid_name');
    // The start ticket is not a teacher token.
    expect((await call('GET', '/api/sessions', { token: ticket })).status).toBe(401);

    const started = await call('POST', '/api/teacher/start', { body: { startTicket: ticket, displayName: ' 김선생 ', agreed: true } });
    expect(started.body).toMatchObject({ ok: true, teacher: { uid, displayName: '김선생' } });
    expect((await call('GET', '/api/sessions', { token: started.body.token })).status).toBe(200);
    const { rows: teacherRows } = await sql('select id from jigsaw.teachers where id = $1', [uid]);
    expect(teacherRows).toHaveLength(1);
    const { rows: profile } = await sql('select display_name, terms_agreed_at from core.profiles where id = $1', [uid]);
    expect(profile[0].display_name).toBe('김선생');
    expect(profile[0].terms_agreed_at).not.toBeNull();

    const again = await call('POST', '/api/teacher/login', { body: { idToken: `google:${uid}`, nonce: NONCE } });
    expect(again.body).toMatchObject({ ok: true, teacher: { uid, displayName: '김선생' } });
    expect(again.body.token).toBeTruthy();
  });

  it('다른 gyosil 앱에서 만든 프로필이 있으면 그 이름을 알려 준다', async () => {
    const uid = await newAccount();
    await sql("insert into core.profiles (id, display_name) values ($1, '다른앱이름')", [uid]);
    const res = await call('POST', '/api/teacher/login', { body: { idToken: `google:${uid}`, nonce: NONCE } });
    expect(res.body).toMatchObject({ needsStart: true, profile: { displayName: '다른앱이름' } });
  });

  it('구글 확인에 실패하거나 nonce 가 다르면 거부한다', async () => {
    expect((await call('POST', '/api/teacher/login', { body: { idToken: 'google:x', nonce: 'other' } })).body).toEqual({
      ok: false,
      error: 'invalid_id_token',
    });
    expect((await call('POST', '/api/teacher/login', { body: { idToken: 'bad', nonce: NONCE } })).status).toBe(401);
    expect((await call('POST', '/api/teacher/login', { body: {} })).status).toBe(400);
  });

  it('위조·만료 토큰, teachers 에 없는 계정은 수업을 열 수 없다', async () => {
    expect((await openClass('forged.token')).status).toBe(401);
    const expired = signTeacherToken(TEACHERS.one.id, SECRET, { now: Date.now() - 13 * 60 * 60 * 1000 });
    expect((await openClass(expired)).status).toBe(401);
    expect((await openClass(signTeacherToken(TEACHERS.one.id, 'another-secret'.padEnd(40, 'y')))).status).toBe(401);
    const outsider = await newAccount();
    expect(await openClass(signTeacherToken(outsider, SECRET))).toMatchObject({ status: 403, body: { error: 'not_teacher' } });
  });
});

describe('수업 API (D1)', () => {
  it('내장 그림으로 수업을 열면 6자리 코드를 받고, 내 수업 목록에 나온다 (비율은 서버의 index.json)', async () => {
    const token = tokenOf(TEACHERS.one);
    const opened = await call('POST', '/api/sessions', {
      token,
      body: { pieceCount: 24, groupCount: 3, picture: { builtinKey: 'sea', aspect: 99 }, hints: { underlay: true } },
    });
    expect(opened.status).toBe(200);
    createdSessions.add(opened.body.sessionId);
    expect(opened.body.code).toMatch(/^\d{6}$/);
    const { rows } = await sql('select aspect::float8 as aspect, cols, rows, hint_underlay, status from jigsaw.sessions where id = $1', [opened.body.sessionId]);
    expect(rows[0]).toMatchObject({ aspect: 1800 / 1200, cols: 6, rows: 4, hint_underlay: true, status: 'waiting' });
    const list = await call('GET', '/api/sessions', { token });
    expect(list.body.sessions.find((s) => s.id === opened.body.sessionId)).toMatchObject({
      code: opened.body.code,
      builtinKey: 'sea',
      pieceCount: 24,
      groupCount: 3,
      hints: { underlay: true, preview: false },
    });
    const other = await call('GET', '/api/sessions', { token: tokenOf(TEACHERS.two) });
    expect(other.body.sessions.some((s) => s.id === opened.body.sessionId)).toBe(false);
  });

  it('잘못된 그림·조각 수는 거부한다', async () => {
    const token = tokenOf(TEACHERS.one);
    expect((await openClass(token, { builtinKey: 'no-such-picture' })).body.error).toBe('invalid_picture');
    expect((await openClass(token, { imageId: randomUUID() })).body.error).toBe('invalid_picture');
    const bad = await call('POST', '/api/sessions', { token, body: { pieceCount: 13, groupCount: 2, picture: { builtinKey: 'sea' } } });
    expect(bad.body.error).toBe('invalid_piece_count');
  });
});

describe('그림 API (D2, D12)', () => {
  it('WebP 를 올리면 저장소와 행이 생기고, 목록의 서명 URL 로 읽힌다', async () => {
    const token = tokenOf(TEACHERS.one);
    const res = await upload(token);
    expect(res.status).toBe(200);
    expect(res.body.image).toMatchObject({ width: 1800, height: 1200 });
    const { rows } = await sql('select path, teacher_id from jigsaw.images where id = $1', [res.body.image.id]);
    expect(rows[0]).toEqual({ path: `${TEACHERS.one.id}/${res.body.image.id}.webp`, teacher_id: TEACHERS.one.id });
    const list = await call('GET', '/api/images', { token });
    const mine = list.body.images.find((i) => i.id === res.body.image.id);
    const fetched = await fetch(mine.url);
    expect(fetched.ok).toBe(true);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(WEBP)).toBe(true);
  });

  it('형식·크기 위반은 거부된다', async () => {
    const token = tokenOf(TEACHERS.one);
    expect((await upload(token, Buffer.from('not a webp at all, just text bytes here'))).body.error).toBe('not_webp');
    expect((await call('POST', '/api/images', { token, raw: WEBP, type: 'image/png' })).status).toBe(415);
    const wide = Buffer.alloc(30);
    wide.write('RIFF', 0);
    wide.write('WEBPVP8X', 8);
    wide.writeUIntLE(2001 - 1, 24, 3);
    wide.writeUIntLE(100 - 1, 27, 3);
    expect((await upload(token, wide)).body.error).toBe('too_big_picture');
    expect((await upload(token, Buffer.concat([WEBP, Buffer.alloc(3 * 1024 * 1024)]))).status).toBe(413);
  });

  it('다른 교사의 그림 목록·서명 URL·삭제·수업 사용은 거부된다 (D12)', async () => {
    const mine = (await upload(tokenOf(TEACHERS.one))).body.image;
    const other = tokenOf(TEACHERS.two);
    const list = await call('GET', '/api/images', { token: other });
    expect(list.body.images.some((i) => i.id === mine.id)).toBe(false);
    expect((await call('GET', `/api/images/${mine.id}/url`, { token: other })).status).toBe(404);
    expect((await call('DELETE', `/api/images/${mine.id}`, { token: other })).status).toBe(404);
    expect((await openClass(other, { imageId: mine.id })).body.error).toBe('invalid_picture');
    const { rows } = await sql('select count(*)::int as n from storage.objects where bucket_id = $1 and name = $2', [
      'jigsaw-images',
      `${TEACHERS.one.id}/${mine.id}.webp`,
    ]);
    expect(rows[0].n).toBe(1);
    expect((await call('GET', `/api/images/${mine.id}/url`, { token: tokenOf(TEACHERS.one) })).status).toBe(200);
  });

  it('열린 수업이 쓰는 그림은 지울 수 없고, 수업이 끝나면 파일까지 지워진다 (D2). 학생은 서명 URL 로 그림을 받는다', async () => {
    const token = tokenOf(TEACHERS.one);
    const image = (await upload(token)).body.image;
    const opened = await openClass(token, { imageId: image.id });
    expect(opened.status).toBe(200);
    const { rows: used } = await sql('select last_used_at > now() - interval \'1 minute\' as fresh from jigsaw.images where id = $1', [image.id]);
    expect(used[0].fresh).toBe(true);

    const student = await call('POST', '/api/join', { body: { code: opened.body.code, name: '그림학생' } });
    const state = await firstState(socketOf({ role: 'student', token: student.body.token, name: '그림학생' }));
    expect(state.session.imageId).toBe(image.id);
    expect((await fetch(state.session.pictureUrl)).ok).toBe(true);

    expect(await call('DELETE', `/api/images/${image.id}`, { token })).toMatchObject({ status: 409, body: { error: 'image_in_use' } });

    const teacher = socketOf({ role: 'teacher', token, sessionId: opened.body.sessionId });
    await firstState(teacher);
    expect(await teacher.timeout(4000).emitWithAck('end', {})).toMatchObject({ ok: true });
    await expect
      .poll(async () => (await sql('select status from jigsaw.sessions where id = $1', [opened.body.sessionId])).rows[0].status)
      .toBe('ended');

    expect((await call('DELETE', `/api/images/${image.id}`, { token })).status).toBe(200);
    createdImages.delete(image.id);
    const { rows } = await sql('select count(*)::int as n from storage.objects where bucket_id = $1 and name = $2', [
      'jigsaw-images',
      `${TEACHERS.one.id}/${image.id}.webp`,
    ]);
    expect(rows[0].n).toBe(0);
    expect((await sql('select count(*)::int as n from jigsaw.images where id = $1', [image.id])).rows[0].n).toBe(0);
    expect((await sql('select image_id from jigsaw.sessions where id = $1', [opened.body.sessionId])).rows[0].image_id).toBeNull();
  });
});

describe('로컬 전용 dev 교사 토큰', () => {
  it('시험 훅이 켜진 로컬에서는 seed 교사의 토큰을 준다', async () => {
    const res = await call('POST', '/api/dev/teacher-token', { body: { teacherId: TEACHERS.one.id } });
    expect(res.status).toBe(200);
    expect((await call('GET', '/api/sessions', { token: res.body.token })).status).toBe(200);
    expect((await call('POST', '/api/dev/teacher-token', { body: { teacherId: randomUUID() } })).status).toBe(404);
  });

  it('운영(NODE_ENV=production)에서는 시험 경로가 없다', async () => {
    const production = await boot({ NODE_ENV: 'production' });
    const root = `http://127.0.0.1:${production.port}`;
    try {
      expect((await call('POST', '/api/dev/teacher-token', { body: { teacherId: TEACHERS.one.id }, root })).status).toBe(404);
      expect((await call('POST', '/api/test/clock', { body: { advanceMs: 1 }, root })).status).toBe(404);
      expect((await call('POST', '/api/test/sessions', { body: {}, root })).status).toBe(404);
    } finally {
      await production.close();
    }
  });
});

describe('교사당 상한 (T20)', () => {
  let limited;
  let root;

  beforeAll(async () => {
    limited = await boot({ RT_MAX_OPEN_PER_TEACHER: '2', RT_MAX_IMAGES_PER_TEACHER: '2', RT_UPLOADS_PER_HOUR: '3' });
    root = `http://127.0.0.1:${limited.port}`;
  });

  afterAll(async () => {
    await limited?.close();
  });

  // A fresh teacher (so classes and pictures of the other tests do not count).
  async function freshTeacher() {
    const uid = await newAccount();
    const login = await call('POST', '/api/teacher/login', { body: { idToken: `google:${uid}`, nonce: NONCE }, root });
    const started = await call('POST', '/api/teacher/start', {
      body: { startTicket: login.body.startTicket, displayName: '상한선생', agreed: true },
      root,
    });
    return started.body.token;
  }

  const uploadTo = async (token) => {
    const res = await call('POST', '/api/images', { token, raw: WEBP, type: 'image/webp', root });
    if (res.status === 200) createdImages.add(res.body.image.id);
    return res;
  };

  it('열린 수업이 교사당 상한을 넘으면 429 too_many_sessions', async () => {
    const token = await freshTeacher();
    for (let i = 0; i < 2; i++) {
      const res = await call('POST', '/api/sessions', { token, body: { pieceCount: 12, groupCount: 1, picture: { builtinKey: 'sea' } }, root });
      expect(res.status).toBe(200);
      createdSessions.add(res.body.sessionId);
    }
    const over = await call('POST', '/api/sessions', { token, body: { pieceCount: 12, groupCount: 1, picture: { builtinKey: 'sea' } }, root });
    expect(over).toMatchObject({ status: 429, body: { error: 'too_many_sessions' } });
  });

  it('그림 수가 교사당 상한이면 409 too_many_images', async () => {
    const token = await freshTeacher();
    expect((await uploadTo(token)).status).toBe(200);
    expect((await uploadTo(token)).status).toBe(200);
    expect(await uploadTo(token)).toMatchObject({ status: 409, body: { error: 'too_many_images' } });
  });

  it('한 시간 업로드 횟수를 넘으면 429 too_many_uploads (지워도 횟수는 남는다)', async () => {
    const token = await freshTeacher();
    for (let i = 0; i < 3; i++) {
      const res = await uploadTo(token);
      expect(res.status).toBe(200);
      expect((await call('DELETE', `/api/images/${res.body.image.id}`, { token, root })).status).toBe(200);
      createdImages.delete(res.body.image.id);
    }
    expect(await uploadTo(token)).toMatchObject({ status: 429, body: { error: 'too_many_uploads' } });
  });
});

describe('경로', () => {
  it('잘못된 %-이스케이프 경로는 404', async () => {
    const res = await call('GET', '/api/images/%E0%A4%A/url', { token: tokenOf(TEACHERS.one) });
    expect(res).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });
});
