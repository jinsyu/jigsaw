// Where a tapped tray piece goes. In order of importance:
// 1. never where it would snap by accident (next to its neighbour, or onto its place);
// 2. never on the frame (pieces there would hide the picture's places);
// 3. clear of other pieces, on screen if possible, else beside the screen (the
//    board view then pans to it), and only when the board edge is full, on top
//    of other pieces;
// 4. as close to the middle of the view as that allows (the frame sits there).
import { SNAP_TOLERANCE } from '../puzzle/snap.js';

const GRID_STEPS_PER_PIECE = 2;
// Keep tabs (up to ~0.3 of a side) on screen as well.
const TAB_INSET = 0.35;
// Centre distance (in piece sizes) that keeps pieces apart: they do not cover each other.
const CLEARANCE = 1.5;
// A cell may poke this much into the frame (the bands above and below it are thinner than a piece).
const FRAME_SLACK = 0.2;
// Keep the origin this much farther than the snap tolerance from any snapping place.
const SNAP_MARGIN = 1.25;

// Candidate positions on one axis: a grid, both ends and a few chosen spots.
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

const RANK = ['risky', 'covers', 'crowded', 'hidden', 'touches'];

function better(a, b) {
  for (const key of RANK) if (a[key] !== b[key]) return a[key] < b[key];
  if (a.clear !== b.clear) return a.clear > b.clear;
  return a.far < b.far;
}

/**
 * @param {object} layout  geometry.layoutFor() result
 * @param {{ x0: number, y0: number, x1: number, y1: number }} view  the screen in board units
 *   (may reach past the board edges)
 * @param {Array<{ x: number, y: number, pieces: number[][] }>} clusters
 * @param {[number, number]} cell  [col, row] of the piece to place
 * @param {{ x0: number, y0: number, x1: number, y1: number } | null} [frame]  frame.frameRect()
 * @returns {{ x: number, y: number }} cluster origin for the piece (may be off screen)
 */
export function freeSpot(layout, view, clusters, cell, frame = null) {
  const { pw, ph } = layout;
  const [col, row] = cell;
  const insetX = Math.min(TAB_INSET * ph, Math.max(0, (view.x1 - view.x0 - pw) / 2));
  const insetY = Math.min(TAB_INSET * pw, Math.max(0, (view.y1 - view.y0 - ph) / 2));
  // On screen: the cell and its tabs. Anywhere: the cell stays on the board.
  const sx0 = view.x0 + insetX;
  const sy0 = view.y0 + insetY;
  const sx1 = view.x1 - insetX - pw;
  const sy1 = view.y1 - insetY - ph;
  const xMax = layout.boardWidth - pw;
  const yMax = layout.boardHeight - ph;

  const centres = clusters.flatMap((c) => c.pieces.map(([cc, rr]) => [c.x + (cc + 0.5) * pw, c.y + (rr + 0.5) * ph]));
  const snapPlaces = clusters
    .filter((c) => c.pieces.some(([cc, rr]) => Math.abs(cc - col) + Math.abs(rr - row) === 1))
    .map((c) => [c.x, c.y]);
  if (frame) {
    snapPlaces.push([frame.x0, frame.y0]);
    centres.push([frame.x0 + (col + 0.5) * pw, frame.y0 + (row + 0.5) * ph]); // its own place
  }
  const enough = CLEARANCE * Math.max(pw, ph);
  const besideX = frame ? [frame.x0 - pw - TAB_INSET * ph, frame.x1 + TAB_INSET * ph] : [];
  const besideY = frame ? [frame.y0 - ph - TAB_INSET * pw, frame.y1 + TAB_INSET * pw] : [];
  const lefts = positions(0, xMax, pw / GRID_STEPS_PER_PIECE, [...besideX, sx0, sx1]);
  const tops = positions(0, yMax, ph / GRID_STEPS_PER_PIECE, [...besideY, sy0, sy1]);
  const midX = (view.x0 + view.x1) / 2;
  const midY = (view.y0 + view.y1) / 2;

  let best = null;
  for (const top of tops) {
    for (const left of lefts) {
      const cx = left + pw / 2;
      const cy = top + ph / 2;
      const ox = left - col * pw;
      const oy = top - row * ph;
      let near = Infinity;
      for (const [x, y] of centres) near = Math.min(near, Math.hypot(x - cx, y - cy));
      const overlap = overlapRatio(left, top, pw, ph, frame);
      const hidden = left >= sx0 - 1e-9 && left <= sx1 + 1e-9 && top >= sy0 - 1e-9 && top <= sy1 + 1e-9 ? 0 : 1;
      const spot = {
        left,
        top,
        risky: snapPlaces.some(([x, y]) => Math.hypot(x - ox, y - oy) <= SNAP_MARGIN * SNAP_TOLERANCE) ? 1 : 0,
        covers: overlap <= FRAME_SLACK ? 0 : Math.round(10 * overlap),
        crowded: near >= enough ? 0 : 1,
        hidden,
        // Among spots on screen, one clear of the frame beats one poking into it (in tenths,
        // so a slightly smaller overlap does not beat a spot nearer the middle). Off screen,
        // the nearest spot wins: the view pans there.
        touches: hidden ? 0 : Math.round(10 * overlap),
        clear: Math.min(near, enough),
        far: Math.hypot(cx - midX, cy - midY),
      };
      if (!best || better(spot, best)) best = spot;
    }
  }
  return { x: best.left - col * pw, y: best.top - row * ph };
}
