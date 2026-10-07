// The teacher's live connection to one class (socket.io, server/src/sockets.js):
// - on every (re)connect the server sends 'state': the class, the roster with names and the
//   overview of every group;
// - then 'events' (join, presence, groups, start, end) and, at most every second, 'overview'
//   with the groups that changed (spec D11: pushed by the server, no polling);
// - the teacher sends assign / randomize / start / end and gets an answer for each.
// socket.io reconnects by itself after a network loss or a server restart (spec D17) and the
// next 'state' replaces everything, so nothing missed while away stays wrong.
import { openSocket } from '../rt-client.js';
import { applyGroupChanges } from './roster.js';

const ANSWER_MS = 8000;
// A connection the server refused for load (too_many_connections) is tried again after this.
const RETRY_MS = 5000;

export class ClassActionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ClassActionError';
    this.code = code;
  }
}

/**
 * Pure state of one class as the teacher sees it; `apply*` return what changed.
 * Kept apart from the socket so it can be unit tested.
 */
export function createClassState({ clock = () => Date.now() } = {}) {
  const state = {
    ready: false,
    setup: null, // session part of 'state' (code, grid, seed, picture, hints, …)
    status: 'waiting',
    startedAt: null, // ms, server clock
    members: [], // roster in joining order: { id, name, group, color, online }
    groups: [], // overview groups by number: { number, empty, completedAt, progress, clusters }
    offset: 0, // server ms - local ms
    awaySince: new Map(), // member id -> local ms they went offline (seen on this page)
  };

  function track(before, after) {
    const was = new Map(before.map((m) => [m.id, m.online]));
    for (const m of after) {
      if (m.online) state.awaySince.delete(m.id);
      else if (was.get(m.id) === true) state.awaySince.set(m.id, clock());
    }
    const ids = new Set(after.map((m) => m.id));
    for (const id of [...state.awaySince.keys()]) if (!ids.has(id)) state.awaySince.delete(id);
  }

  function setMembers(next) {
    track(state.members, next);
    state.members = next;
  }

  function mergeGroups(list) {
    const byNumber = new Map(state.groups.map((g) => [g.number, g]));
    for (const g of list) byNumber.set(g.number, g);
    state.groups = [...byNumber.values()].sort((a, b) => a.number - b.number);
  }

  return {
    state,
    applyState(data) {
      state.ready = true;
      state.setup = data.session;
      state.status = data.overview?.status ?? data.session.status;
      state.startedAt = data.overview?.startedAt ?? data.session.startedAt ?? null;
      state.offset = data.now - clock();
      setMembers(data.roster ?? []);
      state.groups = [...(data.overview?.groups ?? [])].sort((a, b) => a.number - b.number);
      return { kind: 'state' };
    },
    // Returns { kind, needState? } — needState when an event names a student we do not know.
    applyEvent(event) {
      switch (event?.type) {
        case 'join': {
          const m = event.member;
          const known = state.members.some((x) => x.id === m.id);
          setMembers(known ? state.members.map((x) => (x.id === m.id ? { ...x, ...m } : x)) : [...state.members, m]);
          return { kind: 'roster' };
        }
        case 'presence':
          setMembers(state.members.map((x) => (x.id === event.memberId ? { ...x, online: event.online } : x)));
          return { kind: 'roster' };
        case 'groups': {
          const { members, missing } = applyGroupChanges(state.members, event.members ?? []);
          setMembers(members);
          return { kind: 'roster', needState: missing };
        }
        case 'start':
          state.status = 'playing';
          state.startedAt = event.startedAt ?? state.startedAt;
          return { kind: 'start' };
        case 'end':
          state.status = 'ended';
          return { kind: 'end' };
        default:
          return { kind: 'none' };
      }
    },
    applyOverview(data) {
      state.offset = data.now - clock();
      // The end comes as its own event; an overview never reopens or closes the class.
      if (data.status === 'waiting' || data.status === 'playing') state.status = data.status;
      if (data.startedAt != null) state.startedAt = data.startedAt;
      mergeGroups(data.groups ?? []);
      if (Array.isArray(data.members)) setMembers(data.members);
      return { kind: 'overview' };
    },
    // Optimistic move while the server answers (the 'groups' event confirms it).
    moveLocally(memberId, group, color) {
      setMembers(state.members.map((x) => (x.id === memberId ? { ...x, group, color } : x)));
    },
    serverNow: () => clock() + state.offset,
    awayMs(memberId) {
      const since = state.awaySince.get(memberId);
      return since === undefined ? null : Math.max(0, clock() - since);
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.rtUrl
 * @param {string} options.token      teacher token
 * @param {string} options.sessionId
 * @param {(change: { kind: string }) => void} options.onChange
 * @param {(status: 'connecting' | 'ok' | 'lost') => void} options.onConnection
 * @param {(reason: 'invalid_token' | 'forbidden') => void} options.onRefused
 *   invalid_token: sign in again; forbidden: the class is closed or not this teacher's
 */
export function connectClass({ rtUrl, token, sessionId, onChange, onConnection, onRefused }) {
  const model = createClassState();
  let socket = null;
  let closed = false;
  let retryTimer = 0;
  let ending = false; // this page asked to end the class

  const changed = (change) => {
    if (!closed) onChange(change);
  };

  function refetch() {
    // A full 'state' comes with every connect.
    socket?.disconnect().connect();
  }

  openSocket(rtUrl, { role: 'teacher', token, sessionId })
    .then((s) => {
      if (closed) return s.disconnect();
      socket = s;
      onConnection('connecting');
      s.on('connect', () => !closed && onConnection('ok'));
      s.on('disconnect', (reason) => {
        if (closed) return;
        // After 'end' the server closes every socket of the class; nothing to come back to.
        if (reason === 'io server disconnect' && model.state.status === 'ended') return;
        if (reason === 'io server disconnect') s.connect();
        onConnection('lost');
      });
      s.on('connect_error', (error) => {
        if (closed) return;
        if (s.active) return onConnection('lost'); // socket.io tries again by itself
        const reason = error?.message;
        if (reason === 'invalid_token' || reason === 'forbidden') return onRefused(reason);
        onConnection('lost');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => !closed && s.connect(), RETRY_MS);
      });
      s.on('state', (data) => changed(model.applyState(data)));
      s.on('events', (list) => {
        for (const event of Array.isArray(list) ? list : []) {
          const change = model.applyEvent(event);
          if (change.needState) refetch();
          if (change.kind !== 'none') changed(change);
        }
      });
      s.on('overview', (data) => changed(model.applyOverview(data)));
      return s;
    })
    .catch((error) => {
      console.error(error);
      if (!closed) onConnection('lost');
    });

  async function ask(event, message = {}) {
    if (!socket) throw new ClassActionError('not_connected');
    let answer;
    try {
      answer = await socket.timeout(ANSWER_MS).emitWithAck(event, message);
    } catch {
      throw new ClassActionError('timeout');
    }
    if (!answer?.ok) throw new ClassActionError(answer?.error ?? answer?.reason ?? 'refused');
    return answer;
  }

  return {
    model,
    get state() {
      return model.state;
    },
    async assign(memberId, group) {
      const answer = await ask('assign', { memberId, group });
      model.moveLocally(memberId, answer.group ?? null, answer.color ?? null);
      return answer;
    },
    randomize: () => ask('randomize'),
    start: () => ask('start'),
    // While true the 'end' event is this page's own doing (the asking screen says what's next).
    get ending() {
      return ending;
    },
    async end() {
      ending = true;
      try {
        const answer = await ask('end');
        model.state.status = 'ended';
        return answer;
      } catch (error) {
        ending = false;
        throw error;
      }
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      socket?.disconnect();
    },
  };
}
