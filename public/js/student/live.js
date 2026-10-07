// A joined student's live connection to the class (socket.io, server/src/sockets.js):
// - auth { role: 'student', token, name }: the token from POST /api/join; the name goes along
//   so the server has it again after a restart (it keeps names in memory only, spec D14);
// - on every (re)connect, after a move to another group, after the start and on request
//   ('sync') the server sends 'state': the class, me, my group's mates and board;
// - then 'events' (class events: groups, start, end; my group's batched board events),
//   'mates' (my group's names and who is online);
// - puzzle messages take / grab / drop / release are answered one by one (remote-store.js).
// socket.io reconnects by itself after a network loss or a server restart (spec D17).
//
// Order (plan memo T22): the server sends all earlier events of the group before a 'state'
// (broadcaster.flushGroupOf), so group events that come before the first 'state' of a
// connection, or between a 'groups' / 'start' naming me and the 'state' that follows it, are in
// that state already and are dropped here.
import { openSocket } from '../rt-client.js';
import { normalizeName } from './names.js';

const ANSWER_MS = 8000;
// A connection the server refused for load (too_many_connections) is tried again after this.
const RETRY_MS = 5000;
const BOARD_EVENTS = new Set(['take', 'grab', 'drop', 'release', 'tray', 'complete', 'member', 'leave']);

/**
 * The class as this student sees it, kept apart from the socket so it can be unit tested.
 * apply* return what to do: { view } redraw the waiting screen / puzzle frame,
 * { board } a fresh board of my group, { events } board events for my group's puzzle,
 * { ended } the class is over.
 */
export function createStudentModel({ memberId = null, name = '' } = {}) {
  const state = {
    ready: false, // a 'state' arrived on this connection
    waitingForState: true,
    setup: null, // session part of the state: code, grid, seed, picture, hints, startedAt
    status: 'waiting',
    me: { memberId, name, group: null, color: null },
    mates: [], // my group: { id, name (or null), color, online, me }
    serverNow: null, // server ms of the last state
  };

  function mateList(list) {
    return (Array.isArray(list) ? list : []).map((m) => ({
      id: m.id,
      name: m.id === state.me.memberId ? state.me.name : normalizeName(m.name) || null,
      color: Number.isInteger(m.color) ? m.color : 0,
      online: m.id === state.me.memberId || m.online === true,
      me: m.id === state.me.memberId,
    }));
  }

  return {
    state,
    // A new connection: wait for its state.
    connecting() {
      state.waitingForState = true;
    },
    applyState(data) {
      state.ready = true;
      state.waitingForState = false;
      state.setup = data.session;
      state.status = data.session?.status ?? state.status;
      state.serverNow = data.now;
      state.me = {
        memberId: data.me?.memberId ?? state.me.memberId,
        name: state.me.name || normalizeName(data.me?.name),
        group: data.me?.group ?? null,
        color: data.me?.color ?? null,
      };
      state.mates = mateList(data.group?.mates);
      return { view: true, board: data.group?.board ?? null };
    },
    applyEvents(list) {
      const out = { view: false, events: [], ended: false };
      for (const event of Array.isArray(list) ? list : []) {
        switch (event?.type) {
          case 'end':
            out.ended = true;
            return out;
          case 'start':
            state.status = 'playing';
            state.waitingForState = true; // every student gets a state after the start
            out.view = true;
            break;
          case 'groups': {
            const mine = (event.members ?? []).find((m) => m.id === state.me.memberId);
            if (!mine) break;
            state.me = { ...state.me, group: mine.group ?? null, color: mine.color ?? null };
            if (state.me.group === null) state.mates = [];
            state.waitingForState = true; // the server sends a state to every student it names
            out.view = true;
            break;
          }
          default:
            if (BOARD_EVENTS.has(event?.type) && !state.waitingForState && state.me.group !== null) out.events.push(event);
        }
      }
      return out;
    },
    applyMates(data) {
      if (!state.ready || data?.group !== state.me.group) return { view: false };
      state.mates = mateList(data.mates);
      return { view: true };
    },
    rename(next) {
      state.me = { ...state.me, name: next };
      state.mates = state.mates.map((m) => (m.me ? { ...m, name: next } : m));
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.rtUrl
 * @param {string} options.token    student token
 * @param {string} options.name
 * @param {string} [options.memberId]
 * @param {(state: object, change: { board?: object|null, events?: Array }) => void} options.onChange
 *   the model state after a change; `board` with a fresh state, `events` for my group's board
 * @param {(status: 'connecting' | 'ok' | 'lost') => void} options.onConnection
 * @param {() => void} options.onEnded   the class ended (told, or the server no longer knows the token)
 */
export function connectClass({ rtUrl, token, name, memberId = null, onChange, onConnection, onEnded }) {
  const model = createStudentModel({ memberId, name });
  const auth = { role: 'student', token, name };
  let socket = null;
  let closed = false;
  let retryTimer = 0;
  let syncing = false;

  function end() {
    if (closed) return;
    close();
    onEnded();
  }

  function changed(change) {
    if (!closed) onChange(model.state, change);
  }

  openSocket(rtUrl, auth)
    .then((s) => {
      if (closed) return s.disconnect();
      socket = s;
      onConnection('connecting');
      s.on('connect', () => {
        model.connecting();
        if (!closed) onConnection('ok');
      });
      s.on('disconnect', (reason) => {
        if (closed) return;
        // The server closed it: the class ended, or this class is not open there (yet).
        if (reason === 'io server disconnect') s.connect();
        onConnection('lost');
      });
      s.on('connect_error', (error) => {
        if (closed) return;
        if (s.active) return onConnection('lost'); // socket.io tries again by itself
        // The server does not know the token any more: the class is over.
        if (error?.message === 'invalid_token') return end();
        onConnection('lost');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => !closed && s.connect(), RETRY_MS);
      });
      s.on('state', (data) => {
        syncing = false;
        const { board } = model.applyState(data);
        changed({ board });
      });
      s.on('events', (list) => {
        const out = model.applyEvents(list);
        if (out.ended) return end();
        if (out.view || out.events.length) changed({ events: out.events });
      });
      s.on('mates', (data) => {
        if (model.applyMates(data).view) changed({});
      });
      return s;
    })
    .catch((error) => {
      console.error(error);
      if (!closed) onConnection('lost');
    });

  async function ask(event, message = {}) {
    if (!socket?.connected) throw new Error('not connected');
    return socket.timeout(ANSWER_MS).emitWithAck(event, message);
  }

  function close() {
    closed = true;
    clearTimeout(retryTimer);
    socket?.disconnect();
  }

  return {
    model,
    // remote-store.js api: the server's answers ({ ok, ... } or { ok: false, reason }).
    api: {
      take: (piece, x, y) => ask('take', { piece, x, y }),
      grab: (clusterId) => ask('grab', { clusterId }),
      drop: (clusterId, x, y) => ask('drop', { clusterId, x, y }),
      release: (clusterId) => ask('release', clusterId === undefined ? {} : { clusterId }),
    },
    // A fresh state (the board here stopped fitting the events, or the page is back).
    sync() {
      if (syncing || !socket?.connected) return;
      syncing = true;
      ask('sync').catch(() => {}).finally(() => {
        // The state follows the answer; if it never comes, the next request may try again.
        setTimeout(() => {
          syncing = false;
        }, ANSWER_MS);
      });
    },
    rename(next) {
      auth.name = next;
      if (socket) socket.auth = { ...auth };
      model.rename(next);
      changed({});
    },
    close,
  };
}
