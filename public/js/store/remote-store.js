// Class PuzzleStore (see puzzle-store.js) on the rt server: the same contract as local-store.js,
// so the puzzle screen does not know which one it has. The rt server decides (server/src/engine);
// this store shows its decisions.
//
// It talks to the server only through `api` (student/live.js makes one from the class socket;
// unit tests pass a fake), so all the logic here runs without a network:
// - Board: the group part of the server's 'state' (on every connect, after a move to another
//   group, and on request) replaces everything with applyBoard().
// - Events: the group's batched 'events' (take / grab / drop / release / tray / complete) go
//   through applyEvents(). My own take / grab / drop events are skipped: the answer to my
//   message is applied already, and a late echo of my grab would hold a cluster I dropped.
//   The server sends every earlier event of the group before a 'state' or an answer
//   (broadcaster.flushGroupOf), so events and answers arrive in server order; an event that
//   still does not fit the board here asks for a fresh state (onMismatch).
// - Holds: heldAt is the server's grab time on this device's clock (offset from the server
//   time in 'state' and in grab answers), so snap.js judges the 10 s like the server.
//   startedAt and completedAt stay in server time, so their difference is the time taken.
// - Dropping a cluster the server let go of meanwhile (10 s still, 60 s limit; answer
//   'not-held'): grab it again and drop once more, so the move is not lost. If a friend holds
//   it by then the drop is refused with 'held' and the screen slides it back (plan memo T22).
import { clampPosition, progress as progressOf } from '../puzzle/snap.js';
import { shuffledPieces } from './local-store.js';
import { cellOfPiece, normalizeHints, pieceOfCell } from './puzzle-store.js';

// A taken piece waits for the screen's drop() this long before its result is applied anyway.
const TAKE_SETTLE_MS = 3000;
const GROUP_EVENTS = new Set(['take', 'grab', 'drop', 'release', 'tray', 'complete']);

const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isPiece = (value) => Number.isSafeInteger(value) && value >= 0;

export class StoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'StoreError';
  }
}

/**
 * The group board of a student 'state' (server/src/views.js) as the store keeps it.
 * @param {{ clusters: Array, tray: number[], completedAt: number|null }} board
 * @param {(serverMs: number) => number} toLocal
 */
export function clustersFromBoard(board, toLocal) {
  const clusters = new Map();
  for (const c of board?.clusters ?? []) {
    if (!isId(c.id) || !Array.isArray(c.pieces) || c.pieces.length === 0) continue;
    clusters.set(c.id, {
      id: c.id,
      x: c.x,
      y: c.y,
      z: Number.isFinite(c.z) ? c.z : 0,
      locked: c.locked === true,
      heldBy: c.heldBy ?? null,
      heldAt: c.heldBy && Number.isFinite(c.heldAt) ? toLocal(c.heldAt) : null,
      pieces: c.pieces.map(([col, row]) => [col, row]),
    });
  }
  return clusters;
}

/**
 * @param {object} options
 * @param {object} options.api        { take(piece, x, y), grab(clusterId), drop(clusterId, x, y),
 *                                      release(clusterId?) }: Promises of the server's answer;
 *                                      they reject when the server cannot be reached.
 * @param {string} options.me         my member id
 * @param {object} options.layout     geometry.layoutFor()
 * @param {number} options.seed
 * @param {{ src: string, width: number, height: number, credit?: string }} options.picture
 * @param {string} options.groupName
 * @param {object} [options.hints]
 * @param {Array} [options.members]   [{ uid, name, color, online }]
 * @param {number} options.startedAt  ms, server time
 * @param {object} options.board      the group board of the 'state' (clusters, tray, completedAt)
 * @param {number} options.serverNow  the server time the state was made (ms)
 * @param {() => void} [options.onNotPlaying]  an action was refused with not-playing
 * @param {() => void} [options.onMismatch]    the board here no longer fits: ask for a fresh state
 * @param {() => number} [options.now]
 * @param {object} [options.timers]   { setTimeout, clearTimeout }
 */
export function createRemoteStore({
  api,
  me,
  layout,
  seed,
  picture,
  groupName,
  hints: hintOptions,
  members = [],
  startedAt,
  board,
  serverNow,
  onNotPlaying = () => {},
  onMismatch = () => {},
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
  let disposed = false;
  const takes = new Map(); // cluster id -> { result, timer } for taken pieces awaiting drop()
  const taking = new Set(); // tray pieces whose take is on its way
  const listeners = new Set();
  let snapshot = null;

  function freezeMembers(list) {
    return Object.freeze(
      list.map((m) => Object.freeze({ uid: m.uid, name: m.name, color: m.color, online: m.online ?? true })),
    );
  }

  const toLocal = (serverMs) => serverMs - clockOffset;

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

  // ---------- the server's board ----------

  function sortTray(list) {
    return [...new Set(list)].sort((a, b) => trayRank.get(a) - trayRank.get(b));
  }

  function setClock(serverMs, localMs = now()) {
    if (Number.isFinite(serverMs)) clockOffset = serverMs - localMs;
  }

  function loadBoard(next, serverMs) {
    setClock(serverMs);
    clusters = clustersFromBoard(next, toLocal);
    tray = sortTray((next?.tray ?? []).filter((piece) => isPiece(piece) && piece < total && !taking.has(piece)));
    completedAt = Number.isFinite(next?.completedAt) ? next.completedAt : null;
    // Taken pieces waiting for drop() are in this board already, wherever they went.
    for (const taken of takes.values()) {
      timers.clearTimeout(taken.timer);
      taken.stale = true;
    }
  }

  /** A fresh 'state' of my group from the server: replaces the whole board. */
  function applyBoard(next, serverMs) {
    if (disposed) return;
    loadBoard(next, serverMs);
    emit({ type: 'sync' });
  }

  // ---------- applying events (absolute values: applying one twice changes nothing) ----------

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
  // Returns false when the board here does not know the clusters.
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
      // A copy: placeCell takes each cell out of `c`.
      for (const cell of [...c.pieces]) survivor = placeCell(cell, r.id);
      clusters.delete(gone);
    }
    if (!survivor) return false;
    survivor.x = r.x;
    survivor.y = r.y;
    if (Number.isFinite(r.z)) survivor.z = r.z;
    survivor.locked = r.locked === true;
    survivor.heldBy = null;
    survivor.heldAt = null;
    if (Number.isFinite(r.completedAt)) completedAt ??= r.completedAt;
    return known;
  }

  function applyTake(r) {
    if (!isPiece(r.piece) || r.piece >= total || !isId(r.clusterId)) return false;
    removeFromTray(r.piece);
    const c = placeCell(cellOfPiece(r.piece, layout.cols), r.clusterId);
    c.x = r.x;
    c.y = r.y;
    return applySettle(r);
  }

  function applyGrab(r) {
    const c = clusters.get(r.clusterId);
    if (!c) return false;
    c.heldBy = r.by ?? null;
    c.heldAt = Number.isFinite(r.heldAt) ? toLocal(r.heldAt) : now();
    if (Number.isFinite(r.z)) c.z = r.z;
    return true;
  }

  // Only the hold this release ends: an older release must not end a newer hold (mine).
  function applyRelease(r) {
    const c = clusters.get(r.clusterId);
    if (c && (r.by == null || c.heldBy === r.by)) {
      c.heldBy = null;
      c.heldAt = null;
    }
    return true;
  }

  function applyTray(r) {
    for (const p of Array.isArray(r.pieces) ? r.pieces : []) {
      if (!isPiece(p.piece) || p.piece >= total) continue;
      if (p.to === me) tray = sortTray([...tray, p.piece]);
      else removeFromTray(p.piece);
    }
    return true;
  }

  function applyComplete(r) {
    if (Number.isFinite(r.completedAt)) completedAt ??= r.completedAt;
    return true;
  }

  const APPLY = { take: applyTake, drop: applySettle, grab: applyGrab, release: applyRelease, tray: applyTray, complete: applyComplete };

  /** The group's 'events' batch, in order. Other events (member, leave, …) are not the board's. */
  function applyEvents(list) {
    if (disposed) return;
    let fits = true;
    for (const event of Array.isArray(list) ? list : []) {
      const type = event?.type;
      if (!GROUP_EVENTS.has(type)) continue;
      if ((type === 'take' || type === 'grab' || type === 'drop') && event.by === me) continue;
      if (!APPLY[type](event)) fits = false;
      emit({
        type,
        by: event.by ?? null,
        clusterId: event.clusterId ?? null,
        id: event.id ?? null,
        completed: type === 'complete',
      });
    }
    if (!fits) onMismatch();
  }

  // ---------- actions ----------

  async function call(name, promise) {
    try {
      return await promise;
    } catch (error) {
      // No answer: the server may or may not have done it. A fresh state tells.
      onMismatch();
      throw new StoreError(`${name} failed: ${error?.message ?? error}`, error);
    }
  }

  function refusal(answer) {
    const reason = String(answer?.reason ?? 'failed');
    if (reason === 'not-playing') onNotPlaying();
    else if (reason !== 'bad-position' && reason !== 'held' && reason !== 'rate-limited') onMismatch();
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
      answer = await call('take', api.take(piece, x, y));
    } catch (error) {
      putBack(piece);
      throw error;
    }
    if (!answer?.ok) {
      const reason = refusal(answer);
      if (reason === 'not-in-tray') taking.delete(piece); // not mine any more: the fresh state shows it
      else putBack(piece);
      return { ok: false, reason };
    }
    taking.delete(piece);
    // Like local-store: the piece appears held by me at the clamped spot; drop() settles it.
    const cell = cellOfPiece(piece, layout.cols);
    const pos = clampPosition(layout, [cell], x, y);
    removeFromTray(piece);
    const c = placeCell(cell, answer.clusterId);
    Object.assign(c, { x: pos.x, y: pos.y, heldBy: me, heldAt: now(), locked: false });
    if (Number.isFinite(answer.z)) c.z = answer.z;
    const timer = timers.setTimeout(() => settleTake(answer.clusterId), TAKE_SETTLE_MS);
    takes.set(answer.clusterId, { result: answer, timer, stale: false });
    emit({ type: 'take', piece, clusterId: answer.clusterId, by: me });
    return { ok: true, clusterId: answer.clusterId };
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
    const r = taken.result;
    if (taken.stale) return r; // a fresh board has it already
    const fits = applyTake({ ...r, by: me });
    emit({ type: 'drop', clusterId, id: r.id, x: r.x, y: r.y, absorbed: r.absorbed, by: me, completed: Number.isFinite(r.completedAt) });
    if (!fits) onMismatch();
    return r;
  }

  async function grab(clusterId) {
    const cluster = clusters.get(clusterId);
    if (!cluster) return { ok: false, reason: 'not-found' };
    if (cluster.locked) return { ok: false, reason: 'locked' };
    const sentAt = now();
    const answer = await call('grab', api.grab(clusterId));
    const receivedAt = now();
    if (!answer?.ok) {
      const reason = refusal(answer);
      if (reason === 'held' && answer.heldBy) {
        const c = clusters.get(clusterId);
        if (c && c.heldBy !== answer.heldBy) {
          // Someone else got there first: show it now, their grab event follows.
          c.heldBy = answer.heldBy;
          c.heldAt = receivedAt;
          emit({ type: 'grab', clusterId, by: answer.heldBy });
        }
        return { ok: false, reason, heldBy: answer.heldBy };
      }
      return { ok: false, reason };
    }
    if (Number.isFinite(answer.heldAt)) setClock(answer.heldAt, (sentAt + receivedAt) / 2);
    if (applyGrab({ clusterId, by: me, heldAt: answer.heldAt, z: answer.z })) emit({ type: 'grab', clusterId, by: me });
    else onMismatch();
    return { ok: true };
  }

  async function drop(clusterId, x, y) {
    if (takes.has(clusterId)) {
      const r = settleTake(clusterId);
      return { ok: true, id: r.id, x: r.x, y: r.y, absorbed: [...(r.absorbed ?? [])], progress: r.progress };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'bad-position' };
    let answer = await call('drop', api.drop(clusterId, x, y));
    if (answer?.ok === false && answer.reason === 'not-held') {
      // Let go by the server while the finger was still on it: hold it again and put it down.
      const again = await grab(clusterId);
      if (!again.ok) return again;
      answer = await call('drop', api.drop(clusterId, x, y));
    }
    if (!answer?.ok) return { ok: false, reason: refusal(answer) };
    const fits = applySettle(answer);
    const absorbed = [...(answer.absorbed ?? [])];
    emit({ type: 'drop', clusterId, id: answer.id, x: answer.x, y: answer.y, absorbed, by: me, completed: Number.isFinite(answer.completedAt) });
    if (!fits) onMismatch();
    return { ok: true, id: answer.id, x: answer.x, y: answer.y, absorbed, progress: answer.progress };
  }

  /** Lets go of everything I hold without moving it (the page was hidden). */
  async function release() {
    const answer = await call('release', api.release());
    if (!answer?.ok) return { ok: false, reason: String(answer?.reason ?? 'failed') };
    for (const c of clusters.values()) {
      if (c.heldBy === me) {
        c.heldBy = null;
        c.heldAt = null;
      }
    }
    emit({ type: 'release', by: me });
    return { ok: true };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Names and who is online come with the class state (student/live.js), outside the store.
  function setMembers(list) {
    const next = freezeMembers(list);
    if (JSON.stringify(next) === JSON.stringify(memberList)) return;
    memberList = next;
    emit({ type: 'members' });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    for (const { timer } of takes.values()) timers.clearTimeout(timer);
    takes.clear();
  }

  loadBoard(board, serverNow);

  return {
    getState,
    subscribe,
    takeFromTray,
    grab,
    drop,
    dispose,
    // Beyond the PuzzleStore contract, for the class screen:
    release,
    applyBoard,
    applyEvents,
    setMembers,
    get clockOffset() {
      return clockOffset;
    },
  };
}
