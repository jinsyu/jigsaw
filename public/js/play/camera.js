// Board camera: screen = board * scale + (x, y), in CSS pixels of the board view.
// Pure functions so the gesture maths can be unit tested.

import { frameOrigin } from '../puzzle/snap.js';

export const VIEW_PADDING = 12;
// Pieces smaller than this on screen are hard to grab with a finger (mockup phone: ~66px).
export const MIN_PIECE_PX = 64;
// The first view shows the whole frame unless pieces would get smaller than this.
export const MIN_FRAME_PIECE_PX = 44;
export const MAX_PIECE_PX = 320;
// Part of the view that always shows board (or the whole board when it is smaller).
export const KEEP_VISIBLE_RATIO = 0.5;

function fitScales({ viewW, viewH }, w, h) {
  const sx = Math.max(1, viewW - 2 * VIEW_PADDING) / w;
  const sy = Math.max(1, viewH - 2 * VIEW_PADDING) / h;
  return { contain: Math.min(sx, sy), cover: Math.max(sx, sy) };
}

// First zoom, centred on the frame:
// 1. the whole board when pieces are MIN_PIECE_PX or more (tablets, desktop);
// 2. otherwise zoom in toward MIN_PIECE_PX, but keep the whole frame on screen (phones);
// 3. if the whole frame would make pieces smaller than MIN_FRAME_PIECE_PX, fit the
//    frame along its other side instead and leave the rest to panning.
export function fitScale(view, layout) {
  const board = fitScales(view, layout.boardWidth, layout.boardHeight).contain;
  if (layout.pw * board >= MIN_PIECE_PX) return board;
  const frame = fitScales(view, layout.width, layout.height);
  const finger = MIN_PIECE_PX / layout.pw;
  const limit = layout.pw * frame.contain >= MIN_FRAME_PIECE_PX ? frame.contain : frame.cover;
  return Math.max(board, Math.min(finger, limit));
}

// Zooming out always reaches the whole board.
export function scaleLimits(view, layout) {
  const fit = fitScale(view, layout);
  const board = fitScales(view, layout.boardWidth, layout.boardHeight).contain;
  return { min: board * 0.8, max: Math.max(fit, MAX_PIECE_PX / layout.pw) };
}

// Camera with the frame centre in the middle of the view.
export function centeredCamera(view, layout, scale) {
  const t = frameOrigin(layout);
  return {
    scale,
    x: view.viewW / 2 - (t.x + layout.width / 2) * scale,
    y: view.viewH / 2 - (t.y + layout.height / 2) * scale,
  };
}

export function fitCamera(view, layout) {
  return centeredCamera(view, layout, fitScale(view, layout));
}

export function screenToBoard(cam, sx, sy) {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

export function boardToScreen(cam, bx, by) {
  return { x: bx * cam.scale + cam.x, y: by * cam.scale + cam.y };
}

export function clampScale(scale, view, layout) {
  const { min, max } = scaleLimits(view, layout);
  return Math.min(Math.max(scale, min), max);
}

// The board never leaves the screen: at least KEEP_VISIBLE_RATIO of the view (or the
// whole board, if smaller) shows board on each axis. Its edges can still reach the middle.
export function clampCamera(cam, view, layout) {
  const scale = clampScale(cam.scale, view, layout);
  const bw = layout.boardWidth * scale;
  const bh = layout.boardHeight * scale;
  const keepX = Math.min(bw, KEEP_VISIBLE_RATIO * view.viewW);
  const keepY = Math.min(bh, KEEP_VISIBLE_RATIO * view.viewH);
  return {
    scale,
    x: Math.min(Math.max(cam.x, keepX - bw), view.viewW - keepX),
    y: Math.min(Math.max(cam.y, keepY - bh), view.viewH - keepY),
  };
}

// Scale to `scale` keeping the board point under (sx, sy) fixed.
export function zoomAt(cam, scale, sx, sy) {
  const p = screenToBoard(cam, sx, sy);
  return { scale, x: sx - p.x * scale, y: sy - p.y * scale };
}

// Two-finger gesture: the board point under the start midpoint follows the
// current midpoint, scaled by the finger distance ratio (limited by `clamp`).
export function pinchCamera(start, startMid, startDist, mid, dist, clamp = (s) => s) {
  const p = screenToBoard(start, startMid.x, startMid.y);
  const scale = clamp(start.scale * (dist / Math.max(startDist, 1)));
  return { scale, x: mid.x - p.x * scale, y: mid.y - p.y * scale };
}

// The whole view in board units (may reach past the board edges).
export function viewBoardRect(cam, view) {
  const a = screenToBoard(cam, 0, 0);
  const b = screenToBoard(cam, view.viewW, view.viewH);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

// Board rectangle visible in the view, intersected with the board.
export function visibleBoardRect(cam, view, layout) {
  const a = screenToBoard(cam, 0, 0);
  const b = screenToBoard(cam, view.viewW, view.viewH);
  const x0 = Math.max(0, a.x);
  const y0 = Math.max(0, a.y);
  return {
    x0,
    y0,
    x1: Math.max(x0, Math.min(layout.boardWidth, b.x)),
    y1: Math.max(y0, Math.min(layout.boardHeight, b.y)),
  };
}
