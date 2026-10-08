// socket.io: who may connect, which room they join, and the messages they may send.
//
// Connect with auth = { role: 'student', token, name } (token from POST /api/join) or
// { role: 'teacher', token, sessionId } (teacher token, T20). Refused connections get a
// connect_error with one of: forbidden_origin, too_many_connections, invalid_token, forbidden.
//
// Messages (each with an acknowledgement callback):
//   students: take { piece, x, y } · grab { clusterId } · drop { clusterId, x, y } · release { clusterId? }
//             · sync {} (answered { ok: true }, then a fresh 'state')
//   teacher:  assign { memberId, group } · randomize · start · end
// A message from the wrong role is answered { ok: false, reason: 'forbidden' }, a malformed one
// 'bad-request', too many per second 'rate-limited'. Students act only on their own group's
// board and teachers only on the class their token owns (checked when connecting).
import { Server } from 'socket.io';
import { normalizeName } from '../../public/js/student/names.js';
import { createBroadcaster, rooms } from './broadcaster.js';
import { createConnectionCounter, createTokenBucket } from './limits.js';
import { verifyTeacherToken } from './teacher-token.js';
import { studentState, teacherState } from './views.js';

// Disconnects are noticed within about pingInterval + pingTimeout (spec: about 15 s).
export const PING_INTERVAL_MS = 5000;
export const PING_TIMEOUT_MS = 8000;

const isInt = (v) => Number.isSafeInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// [engine action, argument check, arguments]
const STUDENT_MESSAGES = {
  take: ['takeFromTray', (m) => isInt(m.piece) && isNum(m.x) && isNum(m.y), (m) => [m.piece, m.x, m.y]],
  grab: ['grab', (m) => isInt(m.clusterId), (m) => [m.clusterId]],
  drop: ['drop', (m) => isInt(m.clusterId) && isNum(m.x) && isNum(m.y), (m) => [m.clusterId, m.x, m.y]],
  release: ['release', (m) => m.clusterId === undefined || isInt(m.clusterId), (m) => [m.clusterId ?? null]],
};
const TEACHER_MESSAGES = new Set(['assign', 'randomize', 'start', 'end']);

export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function attachSockets({ httpServer, config, registry, persistence, now, pictureUrl = async () => null, log = console }) {
  const { limits } = config;
  const connections = createConnectionCounter({ maxTotal: limits.maxConnections, maxPerKey: limits.maxConnectionsPerIp });
  const studentSockets = new Map(); // member id -> open sockets

  const io = new Server(httpServer, {
    path: '/socket.io/',
    serveClient: false,
    maxHttpBufferSize: limits.socketBytes,
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: PING_TIMEOUT_MS,
    cors: { origin: config.allowedOrigins, methods: ['GET', 'POST'] },
    allowRequest: (req, callback) => {
      const allowed = typeof req.headers.origin === 'string' && config.allowedOrigins.includes(req.headers.origin);
      callback(allowed ? null : 'forbidden_origin', allowed);
    },
  });
  const broadcaster = createBroadcaster(io, { now, pictureUrl, log });
  const urlOf = (session) =>
    pictureUrl(session).catch((error) => {
      log.error(`[socket] 그림 주소를 만들지 못했습니다: ${error?.message ?? error}`);
      return null;
    });

  function deliver(session, events) {
    if (events.length === 0) return;
    broadcaster.dispatch(session, events);
    persistence.persistEvents(session, events);
  }

  // Who the socket is; null when it may not connect.
  function identify(auth) {
    if (auth.role === 'student') {
      const found = registry.byToken(auth.token);
      if (!found) return { error: 'invalid_token' };
      return { role: 'student', sessionId: found.session.id, memberId: found.memberId, name: normalizeName(auth.name) };
    }
    if (auth.role === 'teacher') {
      const uid = verifyTeacherToken(auth.token, config.sessionSecret, now());
      if (!uid) return { error: 'invalid_token' };
      const session = typeof auth.sessionId === 'string' ? registry.session(auth.sessionId) : null;
      if (!session || session.teacherId !== uid) return { error: 'forbidden' };
      return { role: 'teacher', sessionId: session.id };
    }
    return { error: 'invalid_token' };
  }

  io.use((socket, next) => {
    const address = clientAddress(socket.request, config.trustProxy);
    if (!connections.tryOpen(address)) return next(new Error('too_many_connections'));
    const who = identify(isObject(socket.handshake.auth) ? socket.handshake.auth : {});
    if (who.error) {
      connections.close(address);
      return next(new Error(who.error));
    }
    Object.assign(socket.data, who);
    socket.once('disconnect', () => connections.close(address));
    return next();
  });

  io.on('connection', (socket) => {
    const { role, sessionId } = socket.data;
    const bucket = createTokenBucket({ ratePerSecond: limits.messagesPerSecond, now });
    socket.join(rooms.session(sessionId));
    if (role === 'student') onStudent(socket);
    else onTeacher(socket);

    socket.onAny((event, ...args) => {
      const ack = typeof args.at(-1) === 'function' ? args.pop() : () => {};
      const message = args[0] === undefined ? {} : args[0];
      const answer = handle(socket, event, message, bucket);
      if (answer) ack(answer);
    });
  });

  function onStudent(socket) {
    const { sessionId, memberId, name } = socket.data;
    const session = registry.session(sessionId);
    if (!session) return socket.disconnect(true);
    session.touch();
    socket.join(rooms.member(memberId));
    // After a restart the name is gone from memory; the device sends it again.
    if (name && session.member(memberId).name !== name) {
      session.rename(memberId, name);
      deliver(session, [session.joinEvent(session.member(memberId))]);
    }
    broadcaster.attachStudent(session, memberId);
    const open = (studentSockets.get(memberId) ?? 0) + 1;
    studentSockets.set(memberId, open);
    if (open === 1) deliver(session, session.memberOnline(memberId));
    sendStudentState(socket, session);
    socket.on('disconnect', () => {
      const left = (studentSockets.get(memberId) ?? 1) - 1;
      if (left > 0) return studentSockets.set(memberId, left);
      studentSockets.delete(memberId);
      const current = registry.session(sessionId);
      if (current) deliver(current, current.memberOffline(memberId));
    });
  }

  // One full state to this socket; every earlier event of the student's group goes out first.
  function sendStudentState(socket, session) {
    const { memberId } = socket.data;
    urlOf(session).then((url) => {
      const member = session.member(memberId);
      if (!socket.connected || !member) return;
      broadcaster.flushGroupOf(session, member.group);
      socket.emit('state', studentState(session, memberId, now(), url));
    });
  }

  function onTeacher(socket) {
    const session = registry.session(socket.data.sessionId);
    if (!session) return socket.disconnect(true);
    session.touch();
    socket.join(rooms.teacher(session.id));
    urlOf(session).then((url) => {
      if (socket.connected) socket.emit('state', teacherState(session, now(), url));
    });
  }

  function handle(socket, event, message, bucket) {
    const isStudentMessage = Object.hasOwn(STUDENT_MESSAGES, event);
    if (!isStudentMessage && !TEACHER_MESSAGES.has(event) && event !== 'sync') return { ok: false, reason: 'unknown-message' };
    if (!bucket.take()) return { ok: false, reason: 'rate-limited' };
    if (!isObject(message)) return { ok: false, reason: 'bad-request' };
    const session = registry.session(socket.data.sessionId);
    if (!session) return { ok: false, reason: 'not-playing' };

    // A student screen asks for its state again (its board stopped fitting the events).
    if (event === 'sync') {
      if (socket.data.role !== 'student') return { ok: false, reason: 'forbidden' };
      sendStudentState(socket, session);
      return { ok: true };
    }

    if (isStudentMessage) {
      if (socket.data.role !== 'student') return { ok: false, reason: 'forbidden' };
      const [action, valid, args] = STUDENT_MESSAGES[event];
      if (!valid(message)) return { ok: false, reason: 'bad-request' };
      // Everything that happened in the group before this message reaches the student before
      // the answer, so the screen applies events and answers in server order.
      broadcaster.flushGroupOf(session, session.member(socket.data.memberId)?.group);
      const { result, events } = session.puzzle(socket.data.memberId, action, ...args(message));
      deliver(session, events);
      return result;
    }

    if (socket.data.role !== 'teacher') return { ok: false, reason: 'forbidden' };
    if (event === 'assign') {
      const group = message.group === null ? null : message.group;
      if (typeof message.memberId !== 'string' || !(group === null || isInt(group))) return { ok: false, reason: 'bad-request' };
      const { result, events } = session.assign(message.memberId, group);
      deliver(session, events);
      return result;
    }
    if (event === 'randomize' || event === 'start') {
      const { result, events } = event === 'start' ? session.start() : session.randomize();
      deliver(session, events);
      return result;
    }
    // end: registry.end also forgets the class's tokens and code.
    const { result, events } = registry.end(session.id);
    deliver(session, events);
    return result;
  }

  // Timers (tick) and the clean-up job hand their events here.
  function deliverTagged(events) {
    const bySession = new Map();
    for (const { sessionId, ...event } of events) {
      const list = bySession.get(sessionId) ?? [];
      list.push(event);
      bySession.set(sessionId, list);
    }
    for (const [sid, list] of bySession) {
      const session = registry.session(sid);
      if (session) deliver(session, list);
    }
  }

  return {
    io,
    deliver,
    deliverTagged,
    broadcaster,
    get connectionCount() {
      return connections.total;
    },
  };
}
