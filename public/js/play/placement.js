// Where a tapped tray piece goes: a spot on screen that keeps clear of pieces on
// the board (so it does not snap by accident), off the frame if possible, and as
// close to the middle of the view as that allows (the frame sits there).

const GRID_STEPS_PER_PIECE = 2;
// Keep tabs (up to ~0.3 of a side) on screen as well.
const TAB_INSET = 0.35;
// Centre distance (in piece sizes) that keeps pieces apart: they do not cover each
// other and cannot be within snapping distance of a correct neighbour position.
const CLEARANCE = 1.5;

// Candidate positions on one axis: a grid, both ends, and the spots just outside the frame.
function positions(lo, hi, step, extra) {
  const out = [lo, hi];
  for (let v = lo + step; v < hi; v += step) out.push(v);
  for (const v of extra) out.push(Math.min(Math.max(v, lo), hi));
  return out;
}

function overlapRatio(left, top, pw, ph, frame) {
  if (!frame) return 0;
  const w = Math.max(0, Math.min(left + pw, frame.x1) - Math.max(left, frame.x0));
  const h = Math.max(0, Math.min(top + ph, frame.y1) - Math.max(top, frame.y0));
  return (w * h) / (pw * ph);
}

function better(a, b) {
  if (a.clear !== b.clear) return a.clear > b.clear;
  if (a.covers !== b.covers) return a.covers < b.covers;
  return a.far < b.far;
}

/**
 * @param {object} layout  geometry.layoutFor() result
 * @param {{ x0: number, y0: number, x1: number, y1: number }} view  the screen in board units
 *   (may reach past the board edges)
 * @param {Array<{ x: number, y: number, pieces: number[][] }>} clusters
 * @param {[number, number]} cell  [col, row] of the piece to place
 * @param {{ x0: number, y0: number, x1: number, y1: number } | null} [frame]  frame.frameRect()
 * @returns {{ x: number, y: number }} cluster origin for the piece
 */
export function freeSpot(layout, view, clusters, cell, frame = null) {
  const { pw, ph } = layout;
  const insetX = Math.min(TAB_INSET * ph, Math.max(0, (view.x1 - view.x0 - pw) / 2));
  const insetY = Math.min(TAB_INSET * pw, Math.max(0, (view.y1 - view.y0 - ph) / 2));
  // The cell stays on the board, its tabs on screen.
  const x0 = Math.max(0, view.x0 + insetX);
  const y0 = Math.max(0, view.y0 + insetY);
  const xMax = Math.max(x0, Math.min(layout.boardWidth, view.x1 - insetX) - pw);
  const yMax = Math.max(y0, Math.min(layout.boardHeight, view.y1 - insetY) - ph);

  const centres = clusters.flatMap((c) =>
    c.pieces.map(([col, row]) => [c.x + (col + 0.5) * pw, c.y + (row + 0.5) * ph]),
  );
  // Its own place in the frame counts as taken: never drop a piece right onto it.
  if (frame) centres.push([frame.x0 + (cell[0] + 0.5) * pw, frame.y0 + (cell[1] + 0.5) * ph]);
  const enough = CLEARANCE * Math.max(pw, ph);
  const besideX = frame ? [frame.x0 - pw - TAB_INSET * ph, frame.x1 + TAB_INSET * ph] : [];
  const besideY = frame ? [frame.y0 - ph - TAB_INSET * pw, frame.y1 + TAB_INSET * pw] : [];
  const lefts = positions(x0, xMax, pw / GRID_STEPS_PER_PIECE, besideX);
  const tops = positions(y0, yMax, ph / GRID_STEPS_PER_PIECE, besideY);
  const midX = (x0 + xMax + pw) / 2;
  const midY = (y0 + yMax + ph) / 2;

  let best = null;
  for (const top of tops) {
    for (const left of lefts) {
      const cx = left + pw / 2;
      const cy = top + ph / 2;
      let near = Infinity;
      for (const [x, y] of centres) near = Math.min(near, Math.hypot(x - cx, y - cy));
      const spot = {
        left,
        top,
        clear: Math.min(near, enough),
        // In tenths, so a slightly smaller overlap does not beat a spot nearer the middle.
        covers: Math.round(10 * overlapRatio(left, top, pw, ph, frame)),
        far: Math.hypot(cx - midX, cy - midY),
      };
      if (!best || better(spot, best)) best = spot;
    }
  }
  return { x: best.left - cell[0] * pw, y: best.top - cell[1] * ph };
}
