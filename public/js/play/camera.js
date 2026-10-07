// Board camera: screen = board * scale + (x, y), in CSS pixels of the board view.
// Pure functions so the gesture maths can be unit tested.

export const VIEW_PADDING = 12;
// Pieces smaller than this on screen are hard to grab with a finger (mockup phone: ~66px).
export const MIN_PIECE_PX = 64;
// First view on a tall screen: never bigger pieces than this.
export const MAX_START_PIECE_PX = 120;
export const MAX_PIECE_PX = 320;
// Part of the board that must stay on screen while panning.
export const KEEP_VISIBLE_PX = 80;

function containScale({ viewW, viewH }, layout) {
  const w = Math.max(1, viewW - 2 * VIEW_PADDING);
  const h = Math.max(1, viewH - 2 * VIEW_PADDING);
  return Math.min(w / layout.boardWidth, h / layout.boardHeight);
}

// First zoom.
// - Tall view (phone in portrait): the board fills the height and is panned sideways,
//   so no empty bands above and below; pieces at most MAX_START_PIECE_PX.
// - Wide view: the whole board if pieces stay MIN_PIECE_PX or more, otherwise zoom in
//   to that size but never past filling the view; the rest is reached by panning.
export function fitScale(view, layout) {
  const w = Math.max(1, view.viewW - 2 * VIEW_PADDING);
  const h = Math.max(1, view.viewH - 2 * VIEW_PADDING);
  const contain = containScale(view, layout);
  if (view.viewH > view.viewW) {
    return Math.max(contain, Math.min(h / layout.boardHeight, MAX_START_PIECE_PX / layout.pw));
  }
  const cover = Math.max(w / layout.boardWidth, h / layout.boardHeight);
  return Math.max(contain, Math.min(MIN_PIECE_PX / layout.pw, cover));
}

// Zooming out always reaches the whole board.
export function scaleLimits(view, layout) {
  const fit = fitScale(view, layout);
  return { min: containScale(view, layout) * 0.8, max: Math.max(fit, MAX_PIECE_PX / layout.pw) };
}

export function centeredCamera(view, layout, scale) {
  return {
    scale,
    x: (view.viewW - layout.boardWidth * scale) / 2,
    y: (view.viewH - layout.boardHeight * scale) / 2,
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

export function clampCamera(cam, view, layout) {
  const scale = clampScale(cam.scale, view, layout);
  const bw = layout.boardWidth * scale;
  const bh = layout.boardHeight * scale;
  const keepX = Math.min(KEEP_VISIBLE_PX, bw, view.viewW);
  const keepY = Math.min(KEEP_VISIBLE_PX, bh, view.viewH);
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
