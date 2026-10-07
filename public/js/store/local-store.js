// In-memory PuzzleStore (see puzzle-store.js). Used by the solo demo and as the
// reference behaviour for the Supabase store: the same snap.js rules decide drops.
import { clampPosition, progress as progressOf, resolveDrop } from '../puzzle/snap.js';
import { cellOfPiece, normalizeHints } from './puzzle-store.js';

// Moved to puzzle/deal.js (shared with the rt server); kept here for existing importers.
export { shuffledPieces } from '../puzzle/deal.js';

const freezeCluster = (c) =>
  Object.freeze({
    id: c.id,
    x: c.x,
    y: c.y,
    z: c.z,
    locked: c.locked === true,
    heldBy: c.heldBy,
    pieces: Object.freeze(c.pieces.map((cell) => Object.freeze([cell[0], cell[1]]))),
  });

/**
 * @param {object} options
 * @param {object} options.layout      geometry.layoutFor() result
 * @param {number} options.seed
 * @param {{ src: string, width: number, height: number }} options.picture
 * @param {string} options.groupName
 * @param {string} options.me          this device's uid
 * @param {Array<{ uid: string, name: string, color: number, online?: boolean }>} options.members
 * @param {Record<string, number[]>} options.trays   piece indexes per uid
 * @param {Array<{ id: number, x: number, y: number, pieces: number[][], heldBy?: string|null }>} [options.clusters]
 * @param {Partial<import('./puzzle-store.js').Hints>} [options.hints]  help settings (defaults: DEFAULT_HINTS)
 * @param {() => number} [options.now]
 * @returns {import('./puzzle-store.js').PuzzleStore}
 */
export function createLocalStore({
  layout,
  seed,
  picture,
  groupName,
  me,
  members,
  trays,
  clusters: initialClusters = [],
  hints: hintOptions,
  now = () => Date.now(),
}) {
  const hints = normalizeHints(hintOptions);
  const total = layout.cols * layout.rows;
  const trayOf = new Map(Object.entries(trays).map(([uid, list]) => [uid, [...list]]));
  let clusters = initialClusters.map((c, i) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    z: i + 1,
    heldBy: c.heldBy ?? null,
    pieces: c.pieces.map(([col, row]) => [col, row]),
  }));
  let zTop = clusters.length;
  let nextId = clusters.reduce((max, c) => Math.max(max, c.id), 0) + 1;
  const startedAt = now();
  let completedAt = null;
  const listeners = new Set();
  let snapshot = null;

  const memberList = Object.freeze(
    members.map((m) => Object.freeze({ uid: m.uid, name: m.name, color: m.color, online: m.online ?? true })),
  );

  function buildSnapshot() {
    const onBoard = [...clusters].sort((a, b) => a.z - b.z).map(freezeCluster);
    return Object.freeze({
      layout,
      seed,
      picture,
      groupName,
      hints,
      me,
      members: memberList,
      tray: Object.freeze([...(trayOf.get(me) ?? [])]),
      clusters: Object.freeze(onBoard),
      progress: Object.freeze(progressOf(onBoard, total)),
      startedAt,
      completedAt,
    });
  }

  function emit(change) {
    snapshot = null;
    const state = getState();
    for (const listener of [...listeners]) {
      try {
        listener(state, change);
      } catch (error) {
        // One broken listener must not stop the others; still surface the error.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  function getState() {
    snapshot ??= buildSnapshot();
    return snapshot;
  }

  const findCluster = (id) => clusters.find((c) => c.id === id);

  async function takeFromTray(piece, x, y) {
    const tray = trayOf.get(me) ?? [];
    const at = tray.indexOf(piece);
    if (at < 0) return { ok: false, reason: 'not-in-tray' };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'bad-position' };
    tray.splice(at, 1);
    const cell = cellOfPiece(piece, layout.cols);
    const pos = clampPosition(layout, [cell], x, y);
    const cluster = { id: nextId++, x: pos.x, y: pos.y, z: ++zTop, heldBy: me, pieces: [cell] };
    clusters.push(cluster);
    emit({ type: 'take', piece, clusterId: cluster.id, by: me });
    return { ok: true, clusterId: cluster.id };
  }

  async function grab(clusterId) {
    const cluster = findCluster(clusterId);
    if (!cluster) return { ok: false, reason: 'not-found' };
    if (cluster.locked) return { ok: false, reason: 'locked' };
    if (cluster.heldBy && cluster.heldBy !== me) return { ok: false, reason: 'held', heldBy: cluster.heldBy };
    cluster.heldBy = me;
    cluster.z = ++zTop;
    emit({ type: 'grab', clusterId, by: me });
    return { ok: true };
  }

  async function drop(clusterId, x, y) {
    const dropped = findCluster(clusterId);
    if (!dropped) return { ok: false, reason: 'not-found' };
    if (dropped.locked) return { ok: false, reason: 'locked' };
    if (dropped.heldBy !== me) return { ok: false, reason: 'not-held' };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'bad-position' };

    const plain = clusters.map((c) => ({ id: c.id, x: c.x, y: c.y, locked: c.locked, pieces: c.pieces }));
    const result = resolveDrop(layout, plain, { id: clusterId, x, y });
    const topZ = dropped.z;
    const absorbed = new Set(result.absorbed);
    const after = new Map(result.clusters.map((c) => [c.id, c]));
    clusters = clusters
      .filter((c) => !absorbed.has(c.id))
      .map((c) => {
        const next = after.get(c.id);
        return {
          ...c,
          x: next.x,
          y: next.y,
          locked: next.locked,
          pieces: next.pieces.map(([col, row]) => [col, row]),
        };
      });
    const survivor = findCluster(result.id);
    survivor.heldBy = null;
    survivor.z = Math.max(survivor.z, topZ);

    const justCompleted = result.complete && completedAt === null;
    if (justCompleted) completedAt = now();
    const progress = { placed: result.placed, total: result.total, complete: result.complete };
    emit({
      type: 'drop',
      clusterId,
      id: result.id,
      x: result.x,
      y: result.y,
      absorbed: [...result.absorbed],
      by: me,
      completed: justCompleted,
    });
    return { ok: true, id: result.id, x: result.x, y: result.y, absorbed: [...result.absorbed], progress };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    listeners.clear();
  }

  return { getState, subscribe, takeFromTray, grab, drop, dispose };
}

