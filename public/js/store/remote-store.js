// Supabase PuzzleStore (see puzzle-store.js): the same contract as local-store.js, backed by
// the puzzle RPCs (take_from_tray, grab, drop, T5) and the group:<id> broadcasts.
//
// It talks to the server only through `api` (supabase-api.js makes one from a supabase-js
// client; unit tests pass a fake), so all the logic here runs without a network:
// - Board snapshot: loaded on open, whenever the channel (re)subscribes, every `resyncMs`
//   (broadcasts can be lost) and on request. Events that arrive while a snapshot is loading
//   are applied again on top of it; every event sets absolute values, so that is safe.
// - Events: 'take' / 'grab' / 'drop' / 'tray' / 'release' / 'end' broadcasts, and the
//   results of my own calls (my own take/grab/drop broadcasts are skipped: the call result
//   is applied already, and a late echo of my grab would hold a cluster I already dropped).
// - Reasons: the server's reason codes map 1:1 with reason.replaceAll('_', '-').
// - Realtime adds its own message id (uuid) to payloads without an id: only 'take' and
//   'drop' carry a cluster id there, and only a number counts.
// - Holds: heldAt is the server grab time on this device's clock (offset from the server
//   time in grab and heartbeat answers), so snap.js judges the 10 s like the server.
//   startedAt and completedAt stay in server time, so their difference is the time taken.
import { clampPosition, progress as progressOf } from '../puzzle/snap.js';
import { shuffledPieces } from './local-store.js';
import { cellOfPiece, normalizeHints, pieceOfCell } from './puzzle-store.js';

export const RESYNC_MS = 15_000;
// A taken piece waits for the screen's drop() this long before its result is applied anyway.
const TAKE_SETTLE_MS = 3000;

export const reasonOf = (reason) => String(reason ?? 'failed').replaceAll('_', '-');

const isId = (value) => Number.isSafeInteger(value) && value > 0;

export class StoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'StoreError';
  }
}

// Throws a StoreError for transport failures ({ error } from supabase-js).
function unwrap(name, { data, error }) {
  if (error) throw new StoreError(`${name} failed: ${error.message ?? error}`, error);
  return data;
}

/**
 * Builds the board from a snapshot: clusters with their pieces ({ col, row, owner_id, on_board }).
 * @returns {{ clusters: Map<number, object>, trayOwners: Map<number, string|null> }}
 */
export function boardFromSnapshot(snapshot, cols, toLocal) {
  const clusters = new Map();
  const trayOwners = new Map(); // piece index -> owner uid, for pieces still in a tray
  for (const row of snapshot.clusters ?? []) {
    const cells = [];
    for (const p of row.pieces ?? []) {
      if (p.on_board) cells.push([p.col, p.row]);
      else trayOwners.set(pieceOfCell([p.col, p.row], cols), p.owner_id ?? null);
    }
    if (cells.length === 0) continue;
    clusters.set(Number(row.id), {
      id: Number(row.id),
      x: row.x,
      y: row.y,
      z: row.z ?? 0,
      locked: row.locked === true,
      heldBy: row.grabbed_by ?? null,
      heldAt: row.grabbed_by && row.grabbed_at ? toLocal(row.grabbed_at) : null,
      pieces: cells,
    });
  }
  return { clusters, trayOwners };
}

/**
 * @param {object} options
 * @param {object} options.api        { loadBoard(group), take(group, piece, x, y), grab(cluster),
 *                                      drop(cluster, x, y), subscribe(group, { onEvent, onStatus }) }
 * @param {number} options.groupId
 * @param {string} options.me         my user id
 * @param {object} options.layout     geometry.layoutFor()
 * @param {number} options.seed
 * @param {{ src: string, width: number, height: number }} options.picture
 * @param {string} options.groupName
 * @param {object} [options.hints]
 * @param {Array} [options.members]   [{ uid, name, color, online }]
 * @param {number} options.startedAt  ms, server time (sessions.started_at)
 * @param {() => void} [options.onEnd]  the class ended ('end' broadcast)
 * @param {() => void} [options.onNotPlaying]  an action was refused with not_playing (check the session)
 * @param {number} [options.resyncMs]
 * @param {() => number} [options.now]
 * @param {object} [options.timers]   { setTimeout, clearTimeout, setInterval, clearInterval }
 */
export async function openRemoteStore(options) {
  const store = createRemoteStore(options);
  await store.resync();
  store.connect();
  return store;
}

export function createRemoteStore({
  api,
  groupId,
  me,
  layout,
  seed,
  picture,
  groupName,
  hints: hintOptions,
  members = [],
  startedAt,
  onEnd = () => {},
  onNotPlaying = () => {},
  resyncMs = RESYNC_MS,
  now = () => Date.now(),
  timers = globalThis,
}) {
  const hints = normalizeHints(hintOptions);
  const total = layout.cols * layout.rows;
  // Stable, seed-shuffled tray order (row-major order would give the picture away).
  const trayRank = new Map(shuffledPieces(total, seed).map((piece, rank) => [piece, rank]));
  let clusters = new Map();
  let tray = [];
  let completedAt = null;
  let memberList = freezeMembers(members);
  let clockOffset = 0; // server ms - local ms
  let loaded = false;
  let loading = null;
  let reloadQueued = false;
  let pendingEvents = null; // events seen while a snapshot loads
  let disposed = false;
  let ended = false;
  let unsubscribeChannel = null;
  let resyncTimer = 0;
  const takes = new Map(); // cluster id -> { result, timer } for taken pieces awaiting drop()
  const taking = new Set(); // tray pieces whose take_from_tray is on its way
  const listeners = new Set();
  let snapshot = null;

  function freezeMembers(list) {
    return Object.freeze(
      list.map((m) => Object.freeze({ uid: m.uid, name: m.name, color: m.color, online: m.online ?? true })),
    );
  }

  const toLocal = (iso) => Date.parse(iso) - clockOffset;

  // ---------- snapshot ----------

  function buildSnapshot() {
    const onBoard = [...clusters.values()]
      .sort((a, b) => a.z - b.z || a.id - b.id)
      .map((c) =>
        Object.freeze({
          id: c.id,
          x: c.x,
          y: c.y,
          z: c.z,
          locked: c.locked,
          heldBy: c.heldBy,
          heldAt: c.heldAt,
          pieces: Object.freeze(c.pieces.map((cell) => Object.freeze([cell[0], cell[1]]))),
        }),
      );
    return Object.freeze({
      layout,
      seed,
      picture,
      groupName,
      hints,
      me,
      members: memberList,
      tray: Object.freeze([...tray]),
      clusters: Object.freeze(onBoard),
      progress: Object.freeze(progressOf(onBoard, total)),
      startedAt,
      completedAt,
    });
  }

  function getState() {
    snapshot ??= buildSnapshot();
    return snapshot;
  }

  function emit(change) {
    snapshot = null;
    if (disposed) return;
    const state = getState();
    for (const listener of [...listeners]) {
      try {
        listener(state, change);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  // ---------- applying events (all absolute, so applying one twice changes nothing) ----------

  function sortTray(list) {
    return [...new Set(list)].sort((a, b) => trayRank.get(a) - trayRank.get(b));
  }

  function removeFromTray(piece) {
    if (tray.includes(piece)) tray = tray.filter((p) => p !== piece);
  }

  // Puts a piece cell into cluster `id` (created if needed), out of any other cluster.
  function placeCell(cell, id) {
    for (const c of clusters.values()) {
      if (c.id === id) continue;
      const at = c.pieces.findIndex(([col, row]) => col === cell[0] && row === cell[1]);
      if (at >= 0) {
        c.pieces.splice(at, 1);
        if (c.pieces.length === 0) clusters.delete(c.id);
      }
    }
    let target = clusters.get(id);
    if (!target) {
      target = { id, x: 0, y: 0, z: 0, locked: false, heldBy: null, heldAt: null, pieces: [] };
      clusters.set(id, target);
    }
    if (!target.pieces.some(([col, row]) => col === cell[0] && row === cell[1])) target.pieces.push([cell[0], cell[1]]);
    return target;
  }

  // Result of a drop or take: the survivor gets the absorbed pieces, its place and is released.
  // Returns false when the board here does not know the clusters (time to resync).
  function applySettle(r) {
    if (!isId(r.id)) return false;
    let known = true;
    let survivor = clusters.get(r.id);
    const absorbed = Array.isArray(r.absorbed) ? r.absorbed.filter(isId) : [];
    for (const gone of absorbed) {
      const c = clusters.get(gone);
      if (!c) {
        known = false;
        continue;
      }
      for (const cell of c.pieces) survivor = placeCell(cell, r.id);
      clusters.delete(gone);
    }
    if (!survivor) return false;
    survivor.x = r.x;
    survivor.y = r.y;
    if (Number.isFinite(r.z)) survivor.z = r.z;
    survivor.locked = r.locked === true;
    survivor.heldBy = null;
    survivor.heldAt = null;
    if (r.completed_at) completedAt ??= Date.parse(r.completed_at);
    return known;
  }

  function applyTake(r) {
    if (!Number.isInteger(r.piece) || !isId(r.cluster_id)) return false;
    removeFromTray(r.piece);
    const c = placeCell(cellOfPiece(r.piece, layout.cols), r.cluster_id);
    c.x = r.x;
    c.y = r.y;
    return applySettle(r);
  }

  function applyGrab(r) {
    const c = clusters.get(r.cluster_id);
    if (!c) return false;
    c.heldBy = r.by ?? null;
    c.heldAt = r.grabbed_at ? toLocal(r.grabbed_at) : now();
    if (Number.isFinite(r.z)) c.z = r.z;
    return true;
  }

  function applyTray(r) {
    for (const p of Array.isArray(r.pieces) ? r.pieces : []) {
      if (!Number.isInteger(p.col) || !Number.isInteger(p.row)) continue;
      const piece = pieceOfCell([p.col, p.row], layout.cols);
      if (p.owner === me) tray = sortTray([...tray, piece]);
      else removeFromTray(piece);
    }
    return true;
  }

  function applyRelease(r) {
    for (const id of Array.isArray(r.clusters) ? r.clusters : []) {
      const c = clusters.get(id);
      if (c) {
        c.heldBy = null;
        c.heldAt = null;
      }
    }
    return true;
  }

  const APPLY = { take: applyTake, drop: applySettle, grab: applyGrab, tray: applyTray, release: applyRelease };

  // Returns whether the event fitted the board here.
  function apply(type, payload) {
    const fits = APPLY[type](payload);
    if (pendingEvents) pendingEvents.push([type, payload]);
    return fits;
  }

  function onEvent(type, payload = {}) {
    if (disposed) return;
    if (type === 'end') return endClass();
    if (!APPLY[type]) return; // unknown events (and anything Realtime adds) are ignored
    if ((type === 'take' || type === 'grab' || type === 'drop') && payload.by === me) return;
    const fits = apply(type, payload);
    emit({ type, by: payload.by ?? null, clusterId: payload.cluster_id ?? null, id: payload.id ?? null, completed: payload.completed_now === true });
    if (!fits) resync();
  }

  function endClass() {
    if (ended) return;
    ended = true;
    onEnd();
  }

  // ---------- loading ----------

  async function load() {
    pendingEvents = [];
    try {
      const board = await api.loadBoard(groupId);
      const built = boardFromSnapshot(board, layout.cols, toLocal);
      clusters = built.clusters;
      tray = sortTray(
        [...built.trayOwners].filter(([piece, owner]) => owner === me && !taking.has(piece)).map(([piece]) => piece),
      );
      completedAt = board.completed_at ? Date.parse(board.completed_at) : null;
      for (const [type, payload] of pendingEvents) APPLY[type](payload);
      loaded = true;
    } finally {
      pendingEvents = null;
    }
    emit({ type: 'sync' });
  }

  // One load at a time; a request during a load runs once more afterwards.
  function resync() {
    if (disposed) return Promise.resolve();
    if (loading) {
      reloadQueued = true;
      return loading;
    }
    loading = load()
      .catch((error) => {
        if (!loaded) throw error;
        console.error(error);
      })
      .finally(() => {
        loading = null;
        if (reloadQueued && !disposed) {
          reloadQueued = false;
          resync();
        }
      });
    return loading;
  }

  function connect() {
    if (unsubscribeChannel || disposed) return;
    unsubscribeChannel = api.subscribe(groupId, {
      onEvent,
      onStatus(status) {
        if (status === 'SUBSCRIBED') resync(); // catch up on anything sent while away
      },
    });
    resyncTimer = timers.setInterval(() => resync(), resyncMs);
  }

  // ---------- clock ----------

  // serverIso: the server's now() in an answer; sentAt / receivedAt: local ms around the call.
  function noteServerTime(serverIso, sentAt, receivedAt) {
    const server = Date.parse(serverIso);
    if (!Number.isFinite(server)) return;
    clockOffset = server - (sentAt + receivedAt) / 2;
  }

  // ---------- actions ----------

  function refusal(answer) {
    const reason = reasonOf(answer?.reason);
    if (reason === 'not-playing') onNotPlaying(); // the class ended: let the owner check
    else if (reason !== 'bad-position') resync();
    return reason;
  }

  async function takeFromTray(piece, x, y) {
    if (!tray.includes(piece)) return { ok: false, reason: 'not-in-tray' };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'bad-position' };
    // Out of the tray at once, so a quick second tap takes the next piece, not this one again.
    taking.add(piece);
    removeFromTray(piece);
    emit({ type: 'tray' });
    let answer;
    try {
      answer = unwrap('take_from_tray', await api.take(groupId, piece, x, y));
    } catch (error) {
      putBack(piece);
      throw error;
    }
    if (!answer?.ok) {
      const reason = refusal(answer);
      if (reason === 'not-in-tray') taking.delete(piece); // not mine any more: the resync shows it
      else putBack(piece);
      return { ok: false, reason };
    }
    taking.delete(piece);
    // Like local-store: the piece appears held by me at the clamped spot; drop() settles it.
    const cell = cellOfPiece(piece, layout.cols);
    const pos = clampPosition(layout, [cell], x, y);
    removeFromTray(piece);
    const c = placeCell(cell, answer.cluster_id);
    Object.assign(c, { x: pos.x, y: pos.y, heldBy: me, heldAt: now(), locked: false });
    if (Number.isFinite(answer.z)) c.z = answer.z;
    if (pendingEvents) pendingEvents.push(['take', { ...answer, by: me }]);
    const timer = timers.setTimeout(() => settleTake(answer.cluster_id), TAKE_SETTLE_MS);
    takes.set(answer.cluster_id, { result: answer, timer });
    emit({ type: 'take', piece, clusterId: answer.cluster_id, by: me });
    return { ok: true, clusterId: answer.cluster_id };
  }

  function putBack(piece) {
    taking.delete(piece);
    tray = sortTray([...tray, piece]);
    emit({ type: 'tray' });
  }

  function settleTake(clusterId) {
    const taken = takes.get(clusterId);
    if (!taken) return null;
    takes.delete(clusterId);
    timers.clearTimeout(taken.timer);
    const fits = applyTake({ ...taken.result, by: me });
    const r = taken.result;
    emit({ type: 'drop', clusterId, id: r.id, x: r.x, y: r.y, absorbed: r.absorbed, by: me, completed: r.completed_now === true });
    if (!fits) resync();
    return r;
  }

  async function grab(clusterId) {
    const cluster = clusters.get(clusterId);
    if (!cluster) return { ok: false, reason: 'not-found' };
    if (cluster.locked) return { ok: false, reason: 'locked' };
    const sentAt = now();
    const answer = unwrap('grab', await api.grab(clusterId));
    const receivedAt = now();
    if (!answer?.ok) {
      const reason = reasonOf(answer?.reason);
      if (reason === 'held' && answer.held_by) {
        const c = clusters.get(clusterId);
        if (c && c.heldBy !== answer.held_by) {
          // Someone else got there first: show it now, the broadcast fills in the time.
          c.heldBy = answer.held_by;
          c.heldAt = receivedAt;
          emit({ type: 'grab', clusterId, by: answer.held_by });
        }
        return { ok: false, reason, heldBy: answer.held_by };
      }
      return { ok: false, reason: refusal(answer) };
    }
    if (answer.grabbed_at) noteServerTime(answer.grabbed_at, sentAt, receivedAt);
    const payload = { ...answer, by: me };
    if (apply('grab', payload)) emit({ type: 'grab', clusterId, by: me });
    else resync();
    return { ok: true };
  }

  async function drop(clusterId, x, y) {
    if (takes.has(clusterId)) {
      const r = settleTake(clusterId);
      return { ok: true, id: r.id, x: r.x, y: r.y, absorbed: [...(r.absorbed ?? [])], progress: r.progress };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'bad-position' };
    const answer = unwrap('drop', await api.drop(clusterId, x, y));
    if (!answer?.ok) return { ok: false, reason: refusal(answer) };
    const payload = { ...answer, by: me };
    const fits = apply('drop', payload);
    emit({
      type: 'drop',
      clusterId,
      id: answer.id,
      x: answer.x,
      y: answer.y,
      absorbed: [...(answer.absorbed ?? [])],
      by: me,
      completed: answer.completed_now === true,
    });
    if (!fits) resync();
    return { ok: true, id: answer.id, x: answer.x, y: answer.y, absorbed: [...(answer.absorbed ?? [])], progress: answer.progress };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Names and who is online come from Presence (outside the store).
  function setMembers(list) {
    const next = freezeMembers(list);
    if (JSON.stringify(next) === JSON.stringify(memberList)) return;
    memberList = next;
    emit({ type: 'members' });
  }

  // The puzzle is done: no more periodic board reads (broadcasts still arrive).
  function stopResync() {
    timers.clearInterval(resyncTimer);
    resyncTimer = 0;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    timers.clearInterval(resyncTimer);
    for (const { timer } of takes.values()) timers.clearTimeout(timer);
    takes.clear();
    unsubscribeChannel?.();
  }

  return {
    getState,
    subscribe,
    takeFromTray,
    grab,
    drop,
    dispose,
    // Beyond the PuzzleStore contract, for the class screen:
    connect,
    resync,
    stopResync,
    setMembers,
    noteServerTime,
    onEvent,
    get clockOffset() {
      return clockOffset;
    },
  };
}
