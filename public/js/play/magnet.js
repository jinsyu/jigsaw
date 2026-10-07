// Magnet preview: while a piece is dragged, where would it snap if it were let go
// right now? Uses the shared snap rules (snap.js, same as the server), so the
// preview, the slide after the drop and the stored result always agree.
import { SNAP_TOLERANCE, resolveDropWithHolds } from '../puzzle/snap.js';

// Share of the gap the dragged piece leans toward its snap place (a light tug, not a jump).
export const PULL = 0.3;
// The tug fades in over this part of the tolerance after entering it.
const PULL_RAMP = 0.25;

const SIDES = ['top', 'right', 'bottom', 'left'];
const STEP = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const keyOf = ([col, row]) => `${col},${row}`;

/**
 * resolveDropWithHolds on a store snapshot, with the store's heldAt (grab time, ms).
 * The server never clears a hold on a timer: jigsaw_private.held_by_other() only compares the grab
 * time with now (10 s) and checks the holder is online. A snapshot without heldAt
 * cannot be dated, so its hold counts as fresh (left out of merges), which can only
 * differ from the server for a hold older than 10 s. Stores should pass heldAt
 * (see puzzle-store.js).
 * @param {object} layout
 * @param {Array<{ id: number, x: number, y: number, pieces: number[][], locked?: boolean, heldBy?: string|null, heldAt?: number }>} clusters
 * @param {{ id: number, x: number, y: number }} drop
 * @param {{ me: string, now: number, isOnline: (uid: string) => boolean }} holds
 */
export function predictDrop(layout, clusters, drop, holds) {
  const plain = clusters.map(({ id, x, y, locked, pieces, heldBy, heldAt }) => ({
    id,
    x,
    y,
    locked: locked === true,
    pieces,
    heldBy: heldBy ?? null,
    heldAt: heldAt ?? holds.now,
  }));
  return resolveDropWithHolds(layout, plain, drop, holds);
}

/**
 * What to draw while dragging: null when nothing would snap, otherwise
 * { x, y, moving, edges, frameLock, distance, result }.
 * - (x, y): where the merged cluster's picture origin ends up.
 * - moving: cells that will slide to (x, y) (the dragged ones and/or the neighbours).
 * - edges: sides of dragged pieces that will touch a piece they join ({ cell, side }).
 * - frameLock: it lands in the frame and locks there.
 * - distance: from the dragged position to (x, y).
 */
export function snapPreview(layout, clusters, drop, holds) {
  const result = predictDrop(layout, clusters, drop, holds);
  if (result.absorbed.length === 0 && !result.locked) return null;
  const before = new Map(clusters.map((c) => [c.id, c]));
  const dropped = before.get(drop.id);
  const merged = result.clusters.find((c) => c.id === result.id);
  const parts = [...new Set([drop.id, result.id, ...result.absorbed])].map((id) => before.get(id));
  const origin = new Map();
  for (const part of parts) {
    const at = part.id === drop.id ? drop : part;
    for (const cell of part.pieces) origin.set(keyOf(cell), at);
  }
  const moving = merged.pieces.filter((cell) => {
    const at = origin.get(keyOf(cell));
    return at.x !== result.x || at.y !== result.y;
  });
  const dragged = new Set(dropped.pieces.map(keyOf));
  const inMerged = new Set(merged.pieces.map(keyOf));
  const edges = [];
  for (const cell of [...dropped.pieces].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    for (const side of SIDES) {
      const [dc, dr] = STEP[side];
      const next = keyOf([cell[0] + dc, cell[1] + dr]);
      if (inMerged.has(next) && !dragged.has(next)) edges.push({ cell: [cell[0], cell[1]], side });
    }
  }
  return {
    x: result.x,
    y: result.y,
    moving,
    edges,
    frameLock: result.locked && parts.every((p) => p.locked !== true),
    distance: Math.hypot(result.x - drop.x, result.y - drop.y),
    result,
  };
}

// Offset (board units) for drawing the dragged piece: a small lean toward its snap
// place that fades in just inside the tolerance, so it never jumps.
export function pullOffset(preview, from, tol = SNAP_TOLERANCE) {
  if (!preview) return { x: 0, y: 0 };
  const dx = preview.x - from.x;
  const dy = preview.y - from.y;
  const d = Math.hypot(dx, dy);
  const ramp = Math.min(1, Math.max(0, (tol - d) / (PULL_RAMP * tol)));
  return { x: dx * PULL * ramp, y: dy * PULL * ramp };
}

// The Bézier segments of one side of a piece outline (geometry.makePuzzle order:
// top, right, bottom, left; a flat border side is 1 segment, a tab side 6).
export function sideSegments(piece, side, cols, rows) {
  const counts = [
    piece.row === 0 ? 1 : 6,
    piece.col === cols - 1 ? 1 : 6,
    piece.row === rows - 1 ? 1 : 6,
    piece.col === 0 ? 1 : 6,
  ];
  const k = SIDES.indexOf(side);
  const start = counts.slice(0, k).reduce((a, b) => a + b, 0);
  return piece.segments.slice(start, start + counts[k]);
}
