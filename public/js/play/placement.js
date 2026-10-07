// Where a tapped tray piece goes: the spot in the visible board area that is
// farthest from every piece already on the board (so it does not snap by accident).

const GRID_STEPS_PER_PIECE = 2;
// Keep tabs (up to ~0.3 of a side) inside the view as well.
const TAB_INSET = 0.35;

/**
 * @param {object} layout  geometry.layoutFor() result
 * @param {{ x0: number, y0: number, x1: number, y1: number }} view  board rect on screen
 * @param {Array<{ x: number, y: number, pieces: number[][] }>} clusters
 * @param {[number, number]} cell  [col, row] of the piece to place
 * @returns {{ x: number, y: number }} cluster origin for the piece
 */
export function freeSpot(layout, view, clusters, cell) {
  const { pw, ph } = layout;
  const insetX = Math.min(TAB_INSET * ph, Math.max(0, (view.x1 - view.x0 - pw) / 2));
  const insetY = Math.min(TAB_INSET * pw, Math.max(0, (view.y1 - view.y0 - ph) / 2));
  const visible = { x0: view.x0 + insetX, y0: view.y0 + insetY, x1: view.x1 - insetX, y1: view.y1 - insetY };
  const centres = clusters.flatMap((c) =>
    c.pieces.map(([col, row]) => [c.x + (col + 0.5) * pw, c.y + (row + 0.5) * ph]),
  );
  const xMax = Math.max(visible.x0, visible.x1 - pw);
  const yMax = Math.max(visible.y0, visible.y1 - ph);
  const midX = (visible.x0 + visible.x1) / 2;
  const midY = (visible.y0 + visible.y1) / 2;
  let best = null;
  for (let top = visible.y0; top <= yMax + 1e-9; top += ph / GRID_STEPS_PER_PIECE) {
    for (let left = visible.x0; left <= xMax + 1e-9; left += pw / GRID_STEPS_PER_PIECE) {
      const cx = left + pw / 2;
      const cy = top + ph / 2;
      let score = Infinity;
      for (const [x, y] of centres) score = Math.min(score, Math.hypot(x - cx, y - cy));
      // Empty board: prefer the middle of the view.
      if (score === Infinity) score = -Math.hypot(cx - midX, cy - midY);
      if (!best || score > best.score) best = { left, top, score };
    }
  }
  return { x: best.left - cell[0] * pw, y: best.top - cell[1] * ph };
}
