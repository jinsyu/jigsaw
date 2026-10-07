// Drop resolution: board clamp, snap (merge) detection, snapping into the frame
// and progress.
//
// The server implements exactly these rules in SQL (private.resolve_drop and
// private.held_by_other in supabase/migrations/*_puzzle_rpc.sql). Both sides are
// checked against tests/fixtures/snap-cases.json (tests/unit/snap.test.js and
// tests/db/snap-parity.test.js). Change the fixture rules text together with this file.
//
// Data shapes
// - layout: from geometry.layoutFor() — { cols, rows, width, height, pw, ph, boardWidth, boardHeight }.
// - cluster: { id, x, y, locked?, pieces: [[col, row], ...], heldBy?, heldAt? }, ids are
//   integers (bigint in SQL). (x, y) is where the picture origin sits on the board.
//   locked = snapped into the frame (fixed for good). Only clusters on the board are
//   passed in; pieces still in a tray are not clusters here.
//
// Rules (all arithmetic in float64 / float8, same operation order in SQL)
// 0. Frame: the completed picture's place on the board, origin T = frameOrigin(layout)
//    = ((boardWidth - width) / 2, (boardHeight - height) / 2), the middle of the board.
// 1. Clamp: only the dropped cluster's requested position is clamped, once,
//    before merging. With minCol..maxCol / minRow..maxRow of its piece cells
//    (tabs ignored):
//      x = min(max(x, 0 - minCol * pw), boardWidth - (maxCol + 1) * pw)
//      y = min(max(y, 0 - minRow * ph), boardHeight - (maxRow + 1) * ph)
//    Merged positions are never re-clamped.
// 2. Candidates: every other cluster c that has at least one piece
//    edge-adjacent (|dCol| + |dRow| = 1) to a piece of the current cluster and
//      dx = c.x - cur.x, dy = c.y - cur.y, dx*dx + dy*dy <= tol*tol   (inclusive).
//    Diagonal pieces are not neighbours. Locked clusters are candidates too.
// 3. Pick one: smallest dx*dx + dy*dy, ties broken by smallest id.
// 4. Merge: if exactly one of the two is locked, it is the anchor. Otherwise the
//    anchor is the cluster with more pieces (ties: smaller id). The merged cluster
//    keeps the anchor's id and position, and is locked if either was; the other
//    id is appended to `absorbed`.
// 5. Chain: repeat from 2 with the merged cluster until there is no candidate.
//    Only merges reachable from the dropped cluster are considered.
// 6. Frame: if the resulting cluster is not locked and
//      dx = T.x - x, dy = T.y - y, dx*dx + dy*dy <= tol*tol
//    it moves to T and becomes locked. No merging happens after this step.
// Progress: placed = pieces in locked clusters, complete = every piece is locked.
//
// Holds (who is dragging what) only filter the input, see isHeldByOther().

export const SNAP_TOLERANCE = 40;

// A grab blocks others for this long (unless the holder is disconnected).
export const HOLD_MS = 10_000;

const keyOf = ([col, row]) => `${col},${row}`;

function byRowThenCol(a, b) {
  return a[1] - b[1] || a[0] - b[0];
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function copyCluster({ id, x, y, locked, pieces }) {
  return {
    id,
    x,
    y,
    locked: locked === true,
    pieces: pieces.map(([col, row]) => [col, row]).sort(byRowThenCol),
  };
}

export function frameOrigin(layout) {
  return {
    x: (layout.boardWidth - layout.width) / 2,
    y: (layout.boardHeight - layout.height) / 2,
  };
}

export function clampPosition(layout, pieces, x, y) {
  const cols = pieces.map(([col]) => col);
  const rows = pieces.map(([, row]) => row);
  const xLow = 0 - Math.min(...cols) * layout.pw;
  const xHigh = layout.boardWidth - (Math.max(...cols) + 1) * layout.pw;
  const yLow = 0 - Math.min(...rows) * layout.ph;
  const yHigh = layout.boardHeight - (Math.max(...rows) + 1) * layout.ph;
  return {
    x: Math.min(Math.max(x, xLow), xHigh),
    y: Math.min(Math.max(y, yLow), yHigh),
  };
}

function touches(occupied, pieces) {
  return pieces.some(
    ([col, row]) =>
      occupied.has(keyOf([col - 1, row])) ||
      occupied.has(keyOf([col + 1, row])) ||
      occupied.has(keyOf([col, row - 1])) ||
      occupied.has(keyOf([col, row + 1])),
  );
}

function nextCandidate(current, others, tolSquared) {
  const occupied = new Set(current.pieces.map(keyOf));
  let best = null;
  for (const c of others) {
    const dx = c.x - current.x;
    const dy = c.y - current.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > tolSquared || !touches(occupied, c.pieces)) continue;
    if (!best || d2 < best.d2 || (d2 === best.d2 && c.id < best.cluster.id)) {
      best = { cluster: c, d2 };
    }
  }
  return best?.cluster ?? null;
}

function pickAnchor(a, b) {
  if (a.locked !== b.locked) return a.locked ? a : b;
  const bigger = a.pieces.length - b.pieces.length;
  return bigger > 0 || (bigger === 0 && a.id < b.id) ? a : b;
}

function merge(a, b) {
  const anchor = pickAnchor(a, b);
  const other = anchor === a ? b : a;
  return {
    merged: {
      id: anchor.id,
      x: anchor.x,
      y: anchor.y,
      locked: a.locked || b.locked,
      pieces: [...anchor.pieces, ...other.pieces].sort(byRowThenCol),
    },
    absorbedId: other.id,
  };
}

// Merges starting from the dropped cluster at its current (x, y) (rules 2-5).
// Returns { id, x, y, locked, absorbed, clusters } without touching the input.
export function findMerges(clusters, droppedId, tol) {
  const dropped = clusters.find((c) => c.id === droppedId);
  if (!dropped) throw new Error(`dropped cluster not found: ${droppedId}`);

  let current = copyCluster(dropped);
  let others = clusters.filter((c) => c !== dropped).map(copyCluster);
  const absorbed = [];
  const tolSquared = tol * tol;

  let candidate = nextCandidate(current, others, tolSquared);
  while (candidate) {
    const picked = candidate;
    others = others.filter((o) => o !== picked);
    const { merged, absorbedId } = merge(current, picked);
    current = merged;
    absorbed.push(absorbedId);
    candidate = nextCandidate(current, others, tolSquared);
  }

  const result = [...others, current].sort(byId);
  return { id: current.id, x: current.x, y: current.y, locked: current.locked, absorbed, clusters: result };
}

// Rule 6: moves an unlocked cluster that ends up near the frame onto it and locks it.
function snapToFrame(layout, cluster, tol) {
  if (cluster.locked) return cluster;
  const frame = frameOrigin(layout);
  const dx = frame.x - cluster.x;
  const dy = frame.y - cluster.y;
  if (dx * dx + dy * dy > tol * tol) return cluster;
  return { ...cluster, x: frame.x, y: frame.y, locked: true };
}

export function progress(clusters, total) {
  let placed = 0;
  for (const c of clusters) {
    if (c.locked === true) placed += c.pieces.length;
  }
  return { placed, total, complete: total > 0 && placed === total };
}

// Full drop: clamp the requested position, merge, snap into the frame, progress.
// drop = { id, x, y }. Taking a piece out of the tray is the same call with a new
// single-piece cluster for that piece (the server does exactly that).
// Returns { id, x, y, locked, absorbed, clusters, placed, total, complete } where
// id/x/y/locked describe the cluster the dropped pieces ended up in and
// clusters are { id, x, y, locked, pieces } sorted by id.
export function resolveDrop(layout, clusters, drop, tol = SNAP_TOLERANCE) {
  const dropped = clusters.find((c) => c.id === drop.id);
  if (!dropped) throw new Error(`dropped cluster not found: ${drop.id}`);
  // Locked clusters cannot be grabbed, so they are never dropped (SQL raises too).
  if (dropped.locked === true) throw new Error(`dropped cluster is locked: ${drop.id}`);
  const { x, y } = clampPosition(layout, dropped.pieces, drop.x, drop.y);
  const moved = clusters.map((c) => (c === dropped ? { ...c, x, y } : c));
  const merged = findMerges(moved, drop.id, tol);
  const survivor = snapToFrame(layout, merged.clusters.find((c) => c.id === merged.id), tol);
  const result = merged.clusters.map((c) => (c.id === survivor.id ? survivor : c));
  return {
    id: survivor.id,
    x: survivor.x,
    y: survivor.y,
    locked: survivor.locked,
    absorbed: merged.absorbed,
    clusters: result,
    ...progress(result, layout.cols * layout.rows),
  };
}

// Holds. A cluster is held by another student when heldBy is set, heldBy !== me,
// it was grabbed less than HOLD_MS ago (now - heldAt < HOLD_MS, both in ms) and the
// holder is connected (isOnline(heldBy)). Same test as SQL private.held_by_other().
export function isHeldByOther(cluster, me, now, isOnline) {
  return (
    cluster.heldBy != null &&
    cluster.heldBy !== me &&
    now - cluster.heldAt < HOLD_MS &&
    isOnline(cluster.heldBy) === true
  );
}

export function withoutHeldByOthers(clusters, me, now, isOnline) {
  return clusters.filter((c) => !isHeldByOther(c, me, now, isOnline));
}

// Why `me` may not grab this cluster: 'locked' (in the frame), 'held' (another
// student is holding it) or null (grab allowed). Same order as SQL public.grab.
export function grabRefusal(cluster, me, now, isOnline) {
  if (cluster.locked === true) return 'locked';
  if (isHeldByOther(cluster, me, now, isOnline)) return 'held';
  return null;
}

// resolveDrop as the server runs it: clusters held by other students are left out
// of the merge (they stay where they are) but still count for progress.
// holds = { me, now, isOnline }. Same result shape as resolveDrop.
export function resolveDropWithHolds(layout, clusters, drop, holds, tol = SNAP_TOLERANCE) {
  const { me, now, isOnline } = holds;
  const held = clusters.filter((c) => c.id !== drop.id && isHeldByOther(c, me, now, isOnline));
  const free = clusters.filter((c) => !held.includes(c));
  const result = resolveDrop(layout, free, drop, tol);
  const all = [...result.clusters, ...held.map(copyCluster)].sort(byId);
  return { ...result, clusters: all, ...progress(all, layout.cols * layout.rows) };
}
