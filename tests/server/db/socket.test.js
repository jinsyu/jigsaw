// T19: the real rt server process (local Supabase) with socket.io clients.
// D3 names reach the teacher, D6 one grab wins, D11 overview within 3 s, D12 refusals,
// D16 origin / rate / size / connection limits, D17 restart and reconnect.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { signTeacherToken } from '../../../server/src/teacher-token.js';
import { TEACHERS, cleanup, sql } from '../../db/helpers.js';

const SERVER = fileURLToPath(new URL('../../../server/src/index.js', import.meta.url));
const ORIGIN = 'http://localhost:4173';
const SECRET = randomBytes(32).toString('hex');
const NAMES = ['소켓가람', '소켓나래', '소켓다온', '소켓라온'];
// Open classes of the seeded teachers left in the database (other test runs) are restored when
// this server starts; room above the per-teacher and total limits keeps them from failing
// 'open class' here. The E2E tests use their own teachers (scripts/lib/local-teacher.mjs);
// still, do not run pnpm test:db and pnpm test:e2e at the same time on one local stack.
const LIMITS = {
  RT_MAX_OPEN_PER_TEACHER: '100',
  RT_MAX_OPEN_SESSIONS: '400',
  RT_MAX_CONNECTIONS_PER_IP: '25',
  RT_MESSAGES_PER_SECOND: '20',
  RT_WRONG_CODE_LIMIT: '4',
  RT_WRONG_CODE_BONUS: '3',
  RT_WRONG_CODE_WINDOW_MS: '5000',
  RT_WRONG_CODE_BLOCK_MS: '1500',
};

let port;
let child = null;
let output = '';
const sockets = new Set();
const sessionIds = new Set();
const tokens = [];

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 5000, interval = 20 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(interval);
  }
}

async function startServer() {
  const env = inject('supabase');
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SUPABASE_URL: env.url,
      SUPABASE_SERVICE_ROLE_KEY: env.serviceKey,
      SESSION_SECRET: SECRET,
      ALLOWED_ORIGINS: ORIGIN,
      RT_TEST_HOOKS: '1',
      ...LIMITS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok, { timeout: 15000 });
}

function stopServer(signal) {
  const proc = child;
  child = null;
  return new Promise((resolve) => {
    proc.once('exit', (code, sig) => resolve({ code, sig }));
    proc.kill(signal);
  });
}

async function api(path, body, { origin = ORIGIN, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

async function openClass({ groupCount = 2, teacherId = TEACHERS.one.id } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, authorization: `Bearer ${signTeacherToken(teacherId, SECRET)}` },
    body: JSON.stringify({ pieceCount: 12, groupCount, picture: { builtinKey: 'sea' } }),
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  sessionIds.add(body.sessionId);
  return body;
}

async function join(code, name) {
  const { status, body } = await api('/api/join', { code, name });
  expect(status, JSON.stringify(body)).toBe(200);
  tokens.push(body.token);
  return body;
}

function client(auth, { origin = ORIGIN } = {}) {
  const s = connect(`http://127.0.0.1:${port}`, {
    auth,
    transports: ['websocket'],
    extraHeaders: origin ? { origin } : {},
    forceNew: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 300,
  });
  s.events = [];
  s.overviews = [];
  s.states = [];
  s.on('events', (list) => s.events.push(...list));
  s.on('overview', (o) => s.overviews.push(o));
  s.on('state', (st) => s.states.push(st));
  sockets.add(s);
  return s;
}

function connected(s) {
  return new Promise((resolve, reject) => {
    if (s.states.length > 0) return resolve(s.states.at(-1));
    s.once('state', resolve);
    s.once('connect_error', reject);
  });
}

const refusal = (s) =>
  new Promise((resolve) => {
    s.once('connect_error', (error) => resolve(error.message));
    s.once('state', () => resolve('connected'));
  });

const teacherAuth = (sessionId, uid = TEACHERS.one.id) => ({ role: 'teacher', token: signTeacherToken(uid, SECRET), sessionId });
const send = (s, event, message) => s.timeout(4000).emitWithAck(event, message);

function closeAll() {
  for (const s of sockets) s.disconnect();
  sockets.clear();
}

// A started class: group 1 has a and b, group 2 has c.
async function playing() {
  const cls = await openClass();
  const teacher = client(teacherAuth(cls.sessionId));
  await connected(teacher);
  const [a, b, c] = await Promise.all(NAMES.slice(0, 3).map((n) => join(cls.code, n)));
  expect(await send(teacher, 'assign', { memberId: a.memberId, group: 1 })).toMatchObject({ ok: true });
  expect(await send(teacher, 'assign', { memberId: b.memberId, group: 1 })).toMatchObject({ ok: true });
  expect(await send(teacher, 'assign', { memberId: c.memberId, group: 2 })).toMatchObject({ ok: true });
  const students = [a, b, c].map((m, i) => client({ role: 'student', token: m.token, name: NAMES[i] }));
  await Promise.all(students.map(connected));
  expect(await send(teacher, 'start', {})).toMatchObject({ ok: true });
  await waitFor(() => students.every((s) => s.states.at(-1)?.group?.board));
  return { cls, teacher, members: [a, b, c], students };
}

const trayOf = (s) => s.states.at(-1).group.board.tray;

beforeAll(async () => {
  port = await freePort();
  await startServer();
});

afterAll(async () => {
  closeAll();
  if (child) await stopServer('SIGTERM');
  if (sessionIds.size) await sql('delete from jigsaw.sessions where id = any($1::uuid[])', [[...sessionIds]]);
  await cleanup();
});

describe('HTTP', () => {
  it('/health 는 비밀값 없이 상태만 알린다', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, version: '0.1.0' });
    expect(Object.keys(body).sort()).toEqual(['connections', 'ok', 'sessions', 'uptimeSeconds', 'version']);
    const text = JSON.stringify(body);
    expect(text).not.toContain(inject('supabase').serviceKey);
    expect(text).not.toContain(SECRET);
  });

  it('허용되지 않은 Origin·Origin 없는 API 요청은 거부된다 (D16)', async () => {
    expect((await api('/api/join', { code: '000000', name: '가' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('/api/join', { code: '000000', name: '가' }, { origin: null })).status).toBe(403);
    const ok = await api('/api/join', { code: '000000', name: '가' });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('본문이 너무 크면 거부된다 (D16)', async () => {
    const res = await api('/api/join', null, { raw: JSON.stringify({ code: '1', name: 'x'.repeat(5000) }) });
    expect(res.status).toBe(413);
  });
});

describe('소켓', () => {
  it('입장한 이름이 1초 안에 교사 소켓에 도착한다 (D3)', async () => {
    const cls = await openClass();
    const teacher = client(teacherAuth(cls.sessionId));
    await connected(teacher);
    const started = Date.now();
    const student = await join(cls.code, NAMES[3]);
    const event = await waitFor(() => teacher.events.find((e) => e.type === 'join' && e.member.id === student.memberId), {
      timeout: 1000,
    });
    expect(event.member.name).toBe(NAMES[3]);
    expect(Date.now() - started).toBeLessThan(1000);
    closeAll();
  });

  it('동시에 잡으면 한 명만 성공하고, 다른 학생은 잡힌 이벤트를 받는다 (D6)', async () => {
    const { students } = await playing();
    const [a, b] = students;
    const taken = await send(a, 'take', { piece: trayOf(a)[0], x: 10, y: 10 });
    expect(taken.ok).toBe(true);
    const results = await Promise.all([send(a, 'grab', { clusterId: taken.id }), send(b, 'grab', { clusterId: taken.id })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser.reason).toBe('held');
    const winner = results[0].ok ? a : b;
    const other = winner === a ? b : a;
    await waitFor(() => other.events.find((e) => e.type === 'grab' && e.clusterId === taken.id));
    closeAll();
  });

  it('교사 요약이 판이 바뀐 뒤 3초 안에 도착한다 (D11)', async () => {
    const { teacher, students } = await playing();
    const started = Date.now();
    const taken = await send(students[0], 'take', { piece: trayOf(students[0])[0], x: 30, y: 40 });
    const overview = await waitFor(
      () => teacher.overviews.find((o) => o.groups.some((g) => g.number === 1 && g.clusters.some((c) => c.id === taken.id))),
      { timeout: 3000 },
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(overview.groups.find((g) => g.number === 1).clusters.find((c) => c.id === taken.id)).toMatchObject({ x: 30, y: 40 });
    closeAll();
  });

  it('다른 모둠·다른 수업·다른 역할의 요청은 거부된다 (D12)', async () => {
    const { cls, teacher, students } = await playing();
    const [a, b, c] = students;
    const taken = await send(a, 'take', { piece: trayOf(a)[0], x: 10, y: 10 });
    // Group 2's board has no cluster with that id: the group-1 cluster cannot be reached.
    expect(await send(c, 'grab', { clusterId: taken.id })).toEqual({ ok: false, reason: 'not-found' });
    expect(await send(a, 'take', { piece: trayOf(b)[0], x: 0, y: 0 })).toEqual({ ok: false, reason: 'not-in-tray' });
    expect(await send(a, 'start', {})).toEqual({ ok: false, reason: 'forbidden' });
    expect(await send(a, 'end', {})).toEqual({ ok: false, reason: 'forbidden' });
    expect(await send(teacher, 'grab', { clusterId: taken.id })).toEqual({ ok: false, reason: 'forbidden' });
    expect(await send(a, 'grab', { clusterId: 'x' })).toEqual({ ok: false, reason: 'bad-request' });
    // Another teacher, or a forged / missing token, cannot open this class.
    expect(await refusal(client(teacherAuth(cls.sessionId, TEACHERS.two.id)))).toBe('forbidden');
    expect(await refusal(client({ role: 'teacher', token: 'forged.token', sessionId: cls.sessionId }))).toBe('invalid_token');
    expect(await refusal(client({ role: 'student', token: 'not-a-token' }))).toBe('invalid_token');
    closeAll();
  });

  it('허용되지 않은 Origin 의 소켓 연결은 거부된다 (D16)', async () => {
    const cls = await openClass();
    const s = client(teacherAuth(cls.sessionId), { origin: 'https://evil.example' });
    expect(await refusal(s)).not.toBe('connected');
    s.disconnect();
    closeAll();
  });

  it('메시지가 너무 잦으면 rate-limited, 너무 크면 연결을 끊는다 (D16)', async () => {
    const { students } = await playing();
    const [a] = students;
    const answers = await Promise.all(Array.from({ length: 80 }, () => send(a, 'grab', { clusterId: 999 })));
    expect(answers.some((r) => r.reason === 'rate-limited')).toBe(true);
    const dropped = new Promise((resolve) => a.once('disconnect', resolve));
    a.emit('grab', { clusterId: 1, pad: 'x'.repeat(20 * 1024) });
    expect(await dropped).toBeTruthy();
    closeAll();
  });

  it('한 주소의 연결 수 상한을 넘으면 거부된다 (D16)', async () => {
    closeAll();
    await sleep(300);
    const cls = await openClass();
    const opened = [];
    for (let i = 0; i < Number(LIMITS.RT_MAX_CONNECTIONS_PER_IP); i++) opened.push(client(teacherAuth(cls.sessionId)));
    await Promise.all(opened.map(connected));
    expect(await refusal(client(teacherAuth(cls.sessionId)))).toBe('too_many_connections');
    closeAll();
    await sleep(300);
  });
});

describe('재시작 (D17)', () => {
  it('서버가 죽었다 다시 뜨면 수업이 복구되고 소켓이 재접속해 판을 이어 받는다', async () => {
    const { teacher, students } = await playing();
    const [a] = students;
    const first = await send(a, 'take', { piece: trayOf(a)[0], x: 50, y: 60 });
    await sleep(2600); // past the 2-second board save
    await stopServer('SIGKILL');
    const statesBefore = a.states.length;
    await startServer();
    await waitFor(() => a.states.length > statesBefore && teacher.states.length > 1, { timeout: 10000 });
    const board = a.states.at(-1).group.board;
    // Where the server put it (it keeps every piece on the board: clampPosition).
    expect(board.clusters.find((c) => c.id === first.id)).toMatchObject({ x: first.x, y: first.y });
    expect(a.states.at(-1).me.name).toBe(NAMES[0]);

    // SIGTERM: the board change still waiting for its batch is saved before the exit.
    const second = await send(a, 'take', { piece: trayOf(a)[0], x: 300, y: 70 });
    expect(second.ok).toBe(true);
    const stopped = await stopServer('SIGTERM');
    expect(stopped.code).toBe(0);
    const count = a.states.length;
    await startServer();
    await waitFor(() => a.states.length > count, { timeout: 10000 });
    // A piece in the last column or row is pulled in from (300, 70): compare with the server's answer.
    expect(a.states.at(-1).group.board.clusters.find((c) => c.id === second.id)).toMatchObject({ x: second.x, y: second.y });
    closeAll();
  });
});

describe('틀린 코드 반복 (D16)', () => {
  const wrong = () => api('/api/join', { code: '000001', name: '가' });
  const waitWindow = () => sleep(Number(LIMITS.RT_WRONG_CODE_WINDOW_MS) + 100);

  it('한 주소에서 틀린 코드가 한도를 넘으면 잠시 모든 입장을 거부하고, 차단 시간이 지나면 풀린다', async () => {
    const cls = await openClass();
    // Joins earlier in this file count for this address within the window: wait for a new one.
    await waitWindow();
    for (let i = 0; i < Number(LIMITS.RT_WRONG_CODE_LIMIT); i++) expect((await wrong()).status).toBe(404);
    expect((await wrong()).status).toBe(404); // the one over the limit starts the block
    const blocked = await api('/api/join', { code: cls.code, name: '가' });
    expect(blocked).toMatchObject({ status: 429, body: { ok: false, error: 'too_many_attempts' } });
    await sleep(Number(LIMITS.RT_WRONG_CODE_BLOCK_MS) + 100);
    expect((await api('/api/join', { code: cls.code, name: '가' })).status).toBe(200);
  }, 30_000);

  it('같은 주소에서 성공한 입장만큼 한도가 늘어난다 (학교 NAT)', async () => {
    const cls = await openClass();
    await waitWindow();
    // 2 successes allow 4 + 2 x 3 = 10 wrong codes in this window.
    await join(cls.code, '가');
    await join(cls.code, '나');
    for (let i = 0; i < 10; i++) expect((await wrong()).status).toBe(404);
    expect((await api('/api/join', { code: cls.code, name: '다' })).status).toBe(200);
  }, 30_000);
});

describe('로그', () => {
  it('서버 출력에 학생 이름·토큰이 없다 (D14)', () => {
    expect(output).toContain('에서 시작');
    for (const name of NAMES) expect(output).not.toContain(name);
    for (const token of tokens) expect(output).not.toContain(token);
  });
});
