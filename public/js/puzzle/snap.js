// Drop resolution: board clamp, snap (merge) detection and progress.
//
// The server re-implements exactly these rules in SQL (T5) and both sides are
// checked against tests/fixtures/snap-cases.json. Keep the rules simple and
// deterministic, and change the fixture rules text together with this file.
//
// Data shapes
// - layout: from geometry.layoutFor() — { cols, rows, pw, ph, boardWidth, boardHeight }.
// - cluster: { id, x, y, pieces: [[col, row], ...] }, ids are integers (bigint in SQL).
//   (x, y) is where the picture origin sits on the board. Only clusters on the
//   board are passed in; pieces still in a tray are not clusters here.
//
// Rules (all arithmetic in float64 / float8, same operation order in SQL)
// 1. Clamp: only the dropped cluster's requested position is clamped, once,
//    before merging. With minCol..maxCol / minRow..maxRow of its piece cells
//    (tabs ignored):
//      x = min(max(x, 0 - minCol * pw), boardWidth - (maxCol + 1) * pw)
//      y = min(max(y, 0 - minRow * ph), boardHeight - (maxRow + 1) * ph)
//    Merged positions are never re-clamped.
// 2. Candidates: every other cluster c that has at least one piece
//    edge-adjacent (|dCol| + |dRow| = 1) to a piece of the current cluster and
//      dx = c.x - cur.x, dy = c.y - cur.y, dx*dx + dy*dy <= tol*tol   (inclusive).
//    Diagonal pieces are not neighbours.
// 3. Pick one: smallest dx*dx + dy*dy, ties broken by smallest id.
// 4. Merge: the anchor is the cluster with more pieces (ties: smaller id).
//    The merged cluster keeps the anchor's id and position; the other id is
//    appended to `absorbed`.
// 5. Chain: repeat from 2 with the merged cluster until there is no candidate.
//    Only merges reachable from the dropped cluster are considered.
// Progress: placed = pieces in clusters of 2 or more, complete = one cluster
// holds all cols * rows pieces.

export const SNAP_TOLERANCE = 30;

const keyOf = ([col, row]) => `${col},${row}`;

function byRowThenCol(a, b) {
  return a[1] - b[1] || a[0] - b[0];
}

function copyCluster({ id, x, y, pieces }) {
  return { id, x, y, pieces: pieces.map(([col, row]) => [col, row]).sort(byRowThenCol) };
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

function merge(a, b) {
  const bigger = a.pieces.length - b.pieces.length;
  const anchor = bigger > 0 || (bigger === 0 && a.id < b.id) ? a : b;
  const other = anchor === a ? b : a;
  return {
    merged: {
      id: anchor.id,
      x: anchor.x,
      y: anchor.y,
      pieces: [...anchor.pieces, ...other.pieces].sort(byRowThenCol),
    },
    absorbedId: other.id,
  };
}

// Merges starting from the dropped cluster at its current (x, y).
// Returns { id, x, y, absorbed, clusters } without touching the input.
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

  const result = [...others, current].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { id: current.id, x: current.x, y: current.y, absorbed, clusters: result };
}

export function progress(clusters, total) {
  let placed = 0;
  let complete = false;
  for (const c of clusters) {
    if (c.pieces.length >= 2) placed += c.pieces.length;
    if (total > 0 && c.pieces.length === total) complete = true;
  }
  return { placed, total, complete };
}

// Full drop: clamp the requested position, then merge, then progress.
// drop = { id, x, y }.
export function resolveDrop(layout, clusters, drop, tol = SNAP_TOLERANCE) {
  const dropped = clusters.find((c) => c.id === drop.id);
  if (!dropped) throw new Error(`dropped cluster not found: ${drop.id}`);
  const { x, y } = clampPosition(layout, dropped.pieces, drop.x, drop.y);
  const moved = clusters.map((c) => (c === dropped ? { ...c, x, y } : c));
  const merged = findMerges(moved, drop.id, tol);
  return { ...merged, ...progress(merged.clusters, layout.cols * layout.rows) };
}
