// Sends engine events to socket.io rooms and keeps sockets in the right rooms.
//
// Rooms: s:<session> every screen of a class, t:<session> its teacher screens,
//        g:<session>:<group> the students of a group, m:<member> the sockets of one student.
// - Group events are sent in batches every GROUP_BATCH_MS ('events', [ ... ]).
// - Class and teacher events go out at once.
// - The teacher's overview of changed groups goes out at most every OVERVIEW_MS ('overview').
// - After 'groups' / 'start' students are moved between group rooms and get a full 'state';
//   group rooms get 'mates' (names of their students) when membership, names or presence change.
// - After 'end' every socket of the class gets the event and is disconnected.
import { groupMates, studentState } from './views.js';

export const GROUP_BATCH_MS = 100;
export const OVERVIEW_MS = 1000;

export const rooms = {
  session: (sid) => `s:${sid}`,
  teacher: (sid) => `t:${sid}`,
  group: (sid, n) => `g:${sid}:${n}`,
  member: (mid) => `m:${mid}`,
};

export function createBroadcaster(io, { now, timers = { setTimeout, clearTimeout } }) {
  const groupBuffers = new Map(); // room -> events
  const groupTimers = new Map(); // room -> timer
  const overviewDirty = new Map(); // sid -> { session, groups: Set }
  const overviewTimers = new Map(); // sid -> timer
  const memberRoom = new Map(); // member id -> current group room

  function flushGroup(room) {
    groupTimers.delete(room);
    const events = groupBuffers.get(room);
    groupBuffers.delete(room);
    if (events?.length) io.to(room).emit('events', events);
  }

  function queueGroup(session, number, event) {
    const room = rooms.group(session.id, number);
    const list = groupBuffers.get(room) ?? [];
    list.push(event);
    groupBuffers.set(room, list);
    if (!groupTimers.has(room)) groupTimers.set(room, timers.setTimeout(() => flushGroup(room), GROUP_BATCH_MS));
  }

  function flushOverview(sid) {
    overviewTimers.delete(sid);
    const dirty = overviewDirty.get(sid);
    overviewDirty.delete(sid);
    if (!dirty) return;
    const overview = dirty.session.overview();
    io.to(rooms.teacher(sid)).emit('overview', {
      now: now(),
      status: overview.status,
      startedAt: overview.startedAt,
      groups: dirty.all ? overview.groups : overview.groups.filter((g) => dirty.groups.has(g.number)),
      members: overview.members,
    });
  }

  function markOverview(session, number = null) {
    const entry = overviewDirty.get(session.id) ?? { session, groups: new Set(), all: false };
    if (number === null) entry.all = true;
    else entry.groups.add(number);
    overviewDirty.set(session.id, entry);
    if (!overviewTimers.has(session.id)) {
      overviewTimers.set(session.id, timers.setTimeout(() => flushOverview(session.id), OVERVIEW_MS));
    }
  }

  function sendMates(session, number) {
    if (number === null || number === undefined) return;
    io.to(rooms.group(session.id, number)).emit('mates', { group: number, mates: groupMates(session, number) });
  }

  // Puts every socket of a student into the room of their current group.
  function placeStudent(session, memberId) {
    const member = session.member(memberId);
    const target = member?.group == null ? null : rooms.group(session.id, member.group);
    const current = memberRoom.get(memberId) ?? null;
    if (current === target) return false;
    if (current) io.in(rooms.member(memberId)).socketsLeave(current);
    if (target) io.in(rooms.member(memberId)).socketsJoin(target);
    if (target) memberRoom.set(memberId, target);
    else memberRoom.delete(memberId);
    return true;
  }

  function sendState(session, memberId) {
    if (!session.member(memberId)) return;
    io.to(rooms.member(memberId)).emit('state', studentState(session, memberId, now()));
  }

  function dispatch(session, events) {
    const matesFor = new Set();
    for (const event of events) {
      const { to, sessionId: _sessionId, ...payload } = event;
      if (to === 'group') {
        const { group, ...rest } = payload;
        queueGroup(session, group, rest);
        markOverview(session, group);
        if (rest.type === 'member' || rest.type === 'leave') matesFor.add(group);
        continue;
      }
      const room = to === 'teacher' ? rooms.teacher(session.id) : rooms.session(session.id);
      io.to(room).emit('events', [payload]);
      if (payload.type === 'groups' || payload.type === 'start') {
        const moved = payload.type === 'start' ? session.roster().map((m) => m.id) : payload.members.map((m) => m.id);
        for (const id of moved) {
          const before = memberRoom.get(id);
          if (before) matesFor.add(Number(before.split(':')[2]));
          placeStudent(session, id);
          sendState(session, id);
          const group = session.member(id)?.group;
          if (group != null) matesFor.add(group);
        }
        markOverview(session);
      } else if (payload.type === 'join' || payload.type === 'presence') {
        const id = payload.member?.id ?? payload.memberId;
        const group = session.member(id)?.group;
        if (group != null) matesFor.add(group);
        markOverview(session);
      } else if (payload.type === 'end') {
        for (const [room, timer] of groupTimers) {
          if (room.startsWith(`g:${session.id}:`)) {
            timers.clearTimeout(timer);
            flushGroup(room);
          }
        }
        setImmediate(() => io.in(rooms.session(session.id)).disconnectSockets(true));
      }
    }
    for (const number of matesFor) sendMates(session, number);
  }

  // A student socket that just connected: its rooms (the member room is joined by the caller).
  function attachStudent(session, memberId) {
    memberRoom.delete(memberId);
    placeStudent(session, memberId);
  }

  // Sends everything still batched (shutdown).
  function flushAll() {
    for (const [room, timer] of [...groupTimers]) {
      timers.clearTimeout(timer);
      flushGroup(room);
    }
    for (const [sid, timer] of [...overviewTimers]) {
      timers.clearTimeout(timer);
      flushOverview(sid);
    }
  }

  return { dispatch, attachStudent, sendState, flushAll };
}
