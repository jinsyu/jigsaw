// E2E helpers for the teacher screens against the local rt server (pnpm rt:dev, started by
// playwright.config.js) and the local Supabase stack: the seeded test teacher's token (no
// Google sign-in locally), classes opened through the rt API, students played by Node
// socket.io clients (browser students: support/student.js), and direct SQL.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { io as connect } from 'socket.io-client';
import { layoutFor } from '../../../public/js/puzzle/geometry.js';
import { WIDE } from './pictures.js';
import { LOCAL_TEACHER_ID, devTeacherToken, teacherAuthInitScript } from '../../../scripts/lib/local-teacher.mjs';

export const RT_URL = 'http://127.0.0.1:3400';
export const ORIGIN = 'http://localhost:4173';

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
  pool ??= new pg.Pool({ connectionString: localDbUrl(), max: 2 });
  return pool.query(text, params);
}

export async function closeSql() {
  await pool?.end();
  pool = null;
}

const tokens = new Map();

// A teacher token of a seeded teacher from the rt server's dev route.
export async function teacherToken(teacherId = LOCAL_TEACHER_ID) {
  if (!tokens.has(teacherId)) tokens.set(teacherId, await devTeacherToken({ rtUrl: RT_URL, origin: ORIGIN, teacherId }));
  return tokens.get(teacherId);
}

// Puts the teacher token where the page reads it, before any script runs. Returns the token.
export async function signInPage(context, { teacherId = LOCAL_TEACHER_ID } = {}) {
  const token = await teacherToken(teacherId);
  await context.addInitScript(...teacherAuthInitScript(token));
  return token;
}

// A request to the rt server as the page would send it (Origin of the local site).
export async function rtApi(path, { method = 'GET', token, json } = {}) {
  const headers = { origin: ORIGIN };
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${RT_URL}${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// A picture stored through the rt server (like 사진 올리기, without the browser step).
// Returns { id, width, height, url }; removed again by deleteImages().
export async function storeImage(bytes, { teacherId = LOCAL_TEACHER_ID } = {}) {
  const token = await teacherToken(teacherId);
  const res = await fetch(`${RT_URL}/api/images`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'image/webp' },
    body: bytes,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`store image failed: ${res.status} ${body?.error}`);
  return body.image;
}

// Deletes pictures (Storage file and row) straight from the stack, whatever uses them.
export async function deleteImages(ids, storage) {
  if (!ids.length) return;
  const { rows } = await sql('select path from jigsaw.images where id = any($1::uuid[])', [ids]);
  if (rows.length) await storage.from('jigsaw-images').remove(rows.map((r) => r.path));
  await sql('update jigsaw.sessions set image_id = null where image_id = any($1::uuid[])', [ids]);
  await sql('delete from jigsaw.images where id = any($1::uuid[])', [ids]);
}

const openClasses = new Map(); // id -> teacher token
const sockets = new Set();

/**
 * Opens a class through the rt API (like 수업 열기). Returns { id, code, token }.
 * Classes opened here are ended and deleted by cleanUpClasses().
 */
export async function openClass({ pieces = 24, groups = 6, builtinKey = WIDE, imageId = null, hints = {}, teacherId = LOCAL_TEACHER_ID } = {}) {
  const token = await teacherToken(teacherId);
  const picture = imageId ? { imageId } : { builtinKey };
  const { status, body } = await rtApi('/api/sessions', { method: 'POST', token, json: { pieceCount: pieces, groupCount: groups, picture, hints } });
  if (status !== 200) throw new Error(`open class failed: ${status} ${body?.error}`);
  openClasses.set(body.sessionId, token);
  return { id: body.sessionId, code: body.code, token };
}

// A class opened from a page (수업 열기): ended and deleted by cleanUpClasses() too.
export async function trackClass(id, teacherId = LOCAL_TEACHER_ID) {
  openClasses.set(id, await teacherToken(teacherId));
}

function connectSocket(auth) {
  return new Promise((resolve, reject) => {
    const s = connect(RT_URL, { path: '/socket.io/', transports: ['websocket'], extraHeaders: { origin: ORIGIN }, auth, reconnection: false });
    sockets.add(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', (error) => reject(error));
  });
}

const ask = async (socket, event, message = {}) => {
  const answer = await socket.timeout(5000).emitWithAck(event, message);
  if (!answer?.ok) throw new Error(`${event}: ${answer?.error ?? answer?.reason}`);
  return answer;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The teacher's class socket from Node (to set up a class quickly, or end it). It also follows
// what the server tells the teacher: the roster (names -> member ids, groups) and the overview
// of every group (clusters with who holds them), for checks of the server's side.
export async function classControl(cls) {
  const roster = new Map(); // member id -> { id, name, group, color, online }
  const groups = new Map(); // number -> overview group
  const socket = await connectSocket({ role: 'teacher', token: cls.token, sessionId: cls.id });
  const setMembers = (list) => list.forEach((m) => roster.set(m.id, { ...roster.get(m.id), ...m }));
  const setGroups = (list) => list.forEach((g) => groups.set(g.number, g));
  socket.on('state', (state) => {
    setMembers(state.roster ?? []);
    setGroups(state.overview?.groups ?? []);
  });
  socket.on('overview', (overview) => {
    setGroups(overview.groups ?? []);
    setMembers(overview.members ?? []);
  });
  socket.on('events', (list) => {
    for (const e of list) {
      if (e.type === 'join') setMembers([e.member]);
      if (e.type === 'groups') setMembers(e.members);
      if (e.type === 'presence') setMembers([{ id: e.memberId, online: e.online }]);
    }
  });
  const memberNamed = (name) => [...roster.values()].find((m) => m.name === name);
  return {
    socket,
    assign: (memberId, group) => ask(socket, 'assign', { memberId, group }),
    randomize: () => ask(socket, 'randomize'),
    start: () => ask(socket, 'start'),
    end: () => ask(socket, 'end'),
    close: () => socket.disconnect(),
    // The member id of a student, once the teacher has heard of them.
    memberId: async (name) => (await until(() => memberNamed(name))).id,
    member: (name) => memberNamed(name) ?? null,
    // A cluster of group `number` as the server last told the teacher (overview, <= 1 s late).
    cluster: (number, id) => groups.get(number)?.clusters.find((c) => c.id === id) ?? null,
    group: (number) => groups.get(number) ?? null,
  };
}

export async function until(check, { timeout = 10_000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(interval);
  }
}

/**
 * A student without a browser: POST /api/join, then a socket like the student screen's.
 * `leave()` closes the socket (offline), `enter()` connects again with the same token and
 * name (after a server restart the name comes back this way).
 */
export async function nodeStudent(code, name, { present = true } = {}) {
  const { status, body } = await rtApi('/api/join', { method: 'POST', json: { code, name } });
  if (status !== 200) throw new Error(`join failed: ${status} ${body?.error}`);
  const student = {
    name,
    memberId: body.memberId,
    token: body.token,
    socket: null,
    state: null,
    tray: [],
    loose: [], // { clusterId, x, y } of pieces this student put down outside the frame
    events: [], // group and class events received (type only matters to the tests)
    async enter(nameToSend = name) {
      const socket = await connectSocket({ role: 'student', token: body.token, name: nameToSend });
      socket.on('state', (state) => {
        student.state = state;
        student.tray = [...(state.group?.board?.tray ?? [])];
      });
      socket.on('events', (list) => student.events.push(...list));
      this.socket = socket;
    },
    leave() {
      this.socket?.disconnect();
      this.socket = null;
    },
    // Waits for the puzzle (the state after 시작하기) with a tray.
    async ready() {
      await until(() => student.state?.group?.board && student.state.session.status === 'playing');
      return student.state;
    },
    // Takes `count` pieces out of the tray: `locked` into their place in the frame, the rest
    // scattered around the frame. Resolves with the pieces moved.
    async place({ locked = 0, loose = 0, seed = 1 } = {}) {
      const { cols, rows, aspect } = (await this.ready()).session;
      const layout = layoutFor(cols, rows, aspect);
      const ox = (layout.boardWidth - layout.width) / 2;
      const oy = (layout.boardHeight - layout.height) / 2;
      let s = ((seed * 48271) % 2147483646) + 1;
      const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let k = 0; k < 3; k++) rand(); // small seeds start with tiny numbers
      const moved = [];
      for (let i = 0; i < locked + loose && student.tray.length; i++) {
        const piece = student.tray[0];
        const col = piece % cols;
        const row = Math.floor(piece / cols);
        let x = ox;
        let y = oy;
        if (i >= locked) {
          // Somewhere on the board outside the frame; positions are picture origins.
          let cx;
          let cy;
          do {
            cx = 20 + rand() * (layout.boardWidth - 140);
            cy = 20 + rand() * (layout.boardHeight - layout.ph - 40);
          } while (cx > ox - 110 && cx < ox + layout.width + 10 && cy > oy - layout.ph - 10 && cy < oy + layout.height + 10);
          x = cx - col * layout.pw;
          y = cy - row * layout.ph;
        }
        const answer = await this.send('take', { piece, x, y });
        if (i >= locked && !answer.locked) student.loose.push({ clusterId: answer.clusterId, x, y });
        student.tray.shift();
        moved.push(piece);
        await sleep(40); // under the server's 30 messages per second
      }
      return moved;
    },
    // Sends a puzzle message, waiting out the server's rate limit. Resolves with the answer.
    async send(event, message) {
      for (;;) {
        const answer = await this.socket.timeout(5000).emitWithAck(event, message);
        if (answer.ok) return answer;
        if (answer.reason !== 'rate-limited') throw new Error(`${event}: ${answer.reason}`);
        await sleep(200);
      }
    },
    // Picks up one of its loose clusters and puts it down (dx, dy) further. False when the
    // cluster is gone (joined another one) or someone else holds it.
    async nudge(index, dx, dy) {
      const c = student.loose[index];
      if (!c) return false;
      try {
        await this.send('grab', { clusterId: c.clusterId });
        c.x += dx;
        c.y += dy;
        await this.send('drop', { clusterId: c.clusterId, x: c.x, y: c.y });
        await sleep(40);
        return true;
      } catch {
        return false;
      }
    },
  };
  if (present) await student.enter();
  return student;
}

// Ends every class opened by this worker and deletes it (with its groups and members).
// The rows are deleted only after the rt server has saved the end and its last batched board
// saves (at most 2 s later); deleting earlier makes those late saves fail (groups -> sessions
// foreign key) or write the class back.
export async function cleanUpClasses() {
  for (const [id, token] of openClasses) {
    try {
      const control = await classControl({ id, token });
      await control.end().catch(() => {});
      control.close();
    } catch {
      // Already ended (the class refuses new teacher sockets): nothing to end.
    }
  }
  for (const s of sockets) s.disconnect();
  sockets.clear();
  const ids = [...openClasses.keys()];
  openClasses.clear();
  if (!ids.length) return;
  const stillOpen = async () =>
    (await sql("select count(*)::int as n from jigsaw.sessions where id = any($1::uuid[]) and status <> 'ended'", [ids])).rows[0].n;
  const deadline = Date.now() + 10_000;
  while ((await stillOpen()) > 0 && Date.now() < deadline) await sleep(100);
  await sleep(2_500); // past the server's 2-second board save batch
  await sql('delete from jigsaw.sessions where id = any($1::uuid[])', [ids]);
}
