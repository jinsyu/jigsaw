import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import {
  KEEP_VISIBLE_RATIO,
  MIN_FRAME_PIECE_PX,
  MIN_PIECE_PX,
  VIEW_PADDING,
  boardToScreen,
  clampCamera,
  clampScale,
  fitCamera,
  fitScale,
  pinchCamera,
  revealCamera,
  scaleLimits,
  screenToBoard,
  viewBoardRect,
  visibleBoardRect,
  zoomAt,
} from '../../public/js/play/camera.js';
import { frameRect } from '../../public/js/play/frame.js';

const layout = layoutFor(6, 4, 1.5); // picture 600 x 400, board ~849 x 566, frame at ~(124, 83)
const big = layoutFor(10, 7, 1.5); // 70 pieces: picture 1000 x 667
const phone = { viewW: 360, viewH: 560 };
const phone390 = { viewW: 390, viewH: 600 };
const phoneSide = { viewW: 430, viewH: 320 }; // 667 x 375 with the tray on the right
const tablet = { viewW: 788, viewH: 690 };
const tabletTall = { viewW: 768, viewH: 800 }; // 768 x 1024 with the tray below

// Frame rectangle on screen.
function frameOnScreen(cam, lay) {
  const r = frameRect(lay);
  const a = boardToScreen(cam, r.x0, r.y0);
  const b = boardToScreen(cam, r.x1, r.y1);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

const inside = (r, view) => r.x0 >= -1e-9 && r.y0 >= -1e-9 && r.x1 <= view.viewW + 1e-9 && r.y1 <= view.viewH + 1e-9;

describe('fitScale / fitCamera', () => {
  it('shows the whole board when pieces stay big enough (tablets, desktop)', () => {
    for (const view of [tablet, tabletTall, { viewW: 1100, viewH: 780 }]) {
      const scale = fitScale(view, layout);
      expect(layout.boardWidth * scale).toBeLessThanOrEqual(view.viewW);
      expect(layout.boardHeight * scale).toBeLessThanOrEqual(view.viewH);
      expect(layout.pw * scale).toBeGreaterThanOrEqual(MIN_PIECE_PX);
    }
  });

  it('shows the whole frame, centred, on a phone in portrait', () => {
    for (const view of [phone, phone390]) {
      const cam = fitCamera(view, layout);
      const f = frameOnScreen(cam, layout);
      expect(inside(f, view)).toBe(true);
      expect((f.x0 + f.x1) / 2).toBeCloseTo(view.viewW / 2, 9);
      expect((f.y0 + f.y1) / 2).toBeCloseTo(view.viewH / 2, 9);
      // The frame fills the width: pieces as big as the whole frame allows.
      expect(f.x1 - f.x0).toBeCloseTo(view.viewW - 2 * VIEW_PADDING, 9);
      expect(layout.pw * cam.scale).toBeGreaterThanOrEqual(MIN_FRAME_PIECE_PX);
    }
  });

  it('zooms a small wide view in toward finger sized pieces but keeps the whole frame (phone on its side)', () => {
    const cam = fitCamera(phoneSide, layout); // whole board would give 48px pieces
    expect(layout.pw * cam.scale).toBeCloseTo(MIN_PIECE_PX, 9);
    expect(inside(frameOnScreen(cam, layout), phoneSide)).toBe(true);
  });

  it('fits the frame along its other side when the whole frame would make pieces too small', () => {
    const cam = fitCamera(phone, big); // whole frame: 34px pieces
    expect(big.pw * cam.scale).toBeCloseTo(MIN_PIECE_PX, 9);
    const f = frameOnScreen(cam, big);
    expect(f.y0).toBeGreaterThanOrEqual(0); // frame height fits, sides are reached by panning
    expect(f.y1).toBeLessThanOrEqual(phone.viewH);
    expect(f.x1 - f.x0).toBeGreaterThan(phone.viewW);
    expect((f.x0 + f.x1) / 2).toBeCloseTo(phone.viewW / 2, 9);
  });

  it('never zooms in past filling the view with the frame', () => {
    const tiny = { viewW: 120, viewH: 90 };
    const f = frameOnScreen(fitCamera(tiny, layout), layout);
    expect(Math.min(f.x1 - f.x0 - tiny.viewW, f.y1 - f.y0 - tiny.viewH)).toBeLessThanOrEqual(1e-9);
  });

  it('can always zoom out to see the whole board', () => {
    const { min } = scaleLimits(phone, layout);
    expect(layout.boardWidth * min).toBeLessThanOrEqual(phone.viewW);
    expect(layout.boardHeight * min).toBeLessThanOrEqual(phone.viewH);
  });
});

describe('camera transforms', () => {
  it('centres the fitted board', () => {
    const cam = fitCamera(tablet, layout);
    const centre = screenToBoard(cam, tablet.viewW / 2, tablet.viewH / 2);
    expect(centre.x).toBeCloseTo(layout.boardWidth / 2, 9);
    expect(centre.y).toBeCloseTo(layout.boardHeight / 2, 9);
  });

  it('round-trips screen and board points', () => {
    const cam = { scale: 0.73, x: -41, y: 17 };
    const p = boardToScreen(cam, 123.4, 56.7);
    const q = screenToBoard(cam, p.x, p.y);
    expect(q.x).toBeCloseTo(123.4, 9);
    expect(q.y).toBeCloseTo(56.7, 9);
  });

  it('zooms around the given screen point', () => {
    const cam = fitCamera(phone, layout);
    const before = screenToBoard(cam, 100, 200);
    const zoomed = zoomAt(cam, cam.scale * 2, 100, 200);
    const after = screenToBoard(zoomed, 100, 200);
    expect(zoomed.scale).toBeCloseTo(cam.scale * 2, 9);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('pinches: spreading fingers zooms in, moving the midpoint pans', () => {
    const cam = fitCamera(phone, layout);
    const startMid = { x: 180, y: 280 };
    const anchor = screenToBoard(cam, startMid.x, startMid.y);
    const next = pinchCamera(cam, startMid, 100, { x: 200, y: 300 }, 250);
    expect(next.scale).toBeCloseTo(cam.scale * 2.5, 9);
    const moved = screenToBoard(next, 200, 300);
    expect(moved.x).toBeCloseTo(anchor.x, 9);
    expect(moved.y).toBeCloseTo(anchor.y, 9);
  });

  it('keeps the pinch midpoint anchored when the zoom hits its limit', () => {
    const cam = fitCamera(phone, layout);
    const { min } = scaleLimits(phone, layout);
    const mid = { x: 180, y: 280 };
    const anchor = screenToBoard(cam, mid.x, mid.y);
    const next = pinchCamera(cam, mid, 300, mid, 10, (s) => clampScale(s, phone, layout));
    expect(next.scale).toBe(min);
    const after = screenToBoard(next, mid.x, mid.y);
    expect(after.x).toBeCloseTo(anchor.x, 9);
    expect(after.y).toBeCloseTo(anchor.y, 9);
  });

  it('clamps zoom to the limits', () => {
    const { min, max } = scaleLimits(phone, layout);
    expect(clampCamera({ scale: 100, x: 0, y: 0 }, phone, layout).scale).toBe(max);
    expect(clampCamera({ scale: 0.0001, x: 0, y: 0 }, phone, layout).scale).toBe(min);
  });

  it('never lets the board leave the screen: part of the view always shows board', () => {
    const { min, max } = scaleLimits(phone, layout);
    for (const scale of [min, fitScale(phone, layout), 1, max]) {
      for (const [x, y] of [
        [5000, 5000],
        [-5000, -5000],
        [5000, -5000],
        [-5000, 5000],
      ]) {
        const cam = clampCamera({ scale, x, y }, phone, layout);
        const v = visibleBoardRect(cam, phone, layout);
        const shownW = (v.x1 - v.x0) * cam.scale;
        const shownH = (v.y1 - v.y0) * cam.scale;
        const bw = layout.boardWidth * cam.scale;
        const bh = layout.boardHeight * cam.scale;
        expect(shownW).toBeGreaterThanOrEqual(Math.min(bw, KEEP_VISIBLE_RATIO * phone.viewW) - 1e-6);
        expect(shownH).toBeGreaterThanOrEqual(Math.min(bh, KEEP_VISIBLE_RATIO * phone.viewH) - 1e-6);
      }
    }
  });

  it('keeps a board smaller than half the view entirely on screen', () => {
    const { min } = scaleLimits(phone, layout);
    const bh = layout.boardHeight * min;
    expect(bh).toBeLessThan(phone.viewH / 2);
    for (const y of [9999, -9999]) {
      const cam = clampCamera({ scale: min, x: 0, y }, phone, layout);
      expect(cam.y).toBeGreaterThanOrEqual(0);
      expect(cam.y + bh).toBeLessThanOrEqual(phone.viewH + 1e-9);
    }
  });

  it('still reaches every board corner when zoomed in', () => {
    const { max } = scaleLimits(phone, layout);
    const left = clampCamera({ scale: max, x: 9999, y: 9999 }, phone, layout);
    expect(screenToBoard(left, 0, 0).x).toBeLessThanOrEqual(0);
    expect(screenToBoard(left, 0, 0).y).toBeLessThanOrEqual(0);
    const right = clampCamera({ scale: max, x: -99999, y: -99999 }, phone, layout);
    const corner = screenToBoard(right, phone.viewW, phone.viewH);
    expect(corner.x).toBeGreaterThanOrEqual(layout.boardWidth);
    expect(corner.y).toBeGreaterThanOrEqual(layout.boardHeight);
  });

  it('reports the visible part of the board', () => {
    const cam = { scale: 1, x: -100, y: -50 };
    expect(visibleBoardRect(cam, { viewW: 300, viewH: 200 }, layout)).toEqual({ x0: 100, y0: 50, x1: 400, y1: 250 });
    const all = visibleBoardRect(fitCamera(tablet, layout), tablet, layout);
    expect(all.x0).toBe(0);
    expect(all.x1).toBe(layout.boardWidth);
  });

  it('reports the whole view in board units, past the board edges too', () => {
    const cam = { scale: 2, x: 100, y: -40 };
    expect(viewBoardRect(cam, { viewW: 300, viewH: 200 })).toEqual({ x0: -50, y0: 20, x1: 100, y1: 120 });
  });
});

describe('revealCamera', () => {
  const cam = fitCamera(phone, layout);

  it('does not move when the rectangle is already in view', () => {
    const c = screenToBoard(cam, phone.viewW / 2, phone.viewH / 2);
    expect(revealCamera(cam, phone, layout, { x0: c.x - 10, y0: c.y - 10, x1: c.x + 10, y1: c.y + 10 })).toEqual(cam);
  });

  it('pans just enough to bring an off-screen rectangle in, keeping the zoom', () => {
    const rect = { x0: 0, y0: 200, x1: 100, y1: 300 }; // board left edge, off a phone screen
    expect(screenToBoard(cam, 0, 0).x).toBeGreaterThan(0);
    const next = revealCamera(cam, phone, layout, rect, 8);
    expect(next.scale).toBe(cam.scale);
    const a = boardToScreen(next, rect.x0, rect.y0);
    expect(a.x).toBeCloseTo(8, 6);
    expect(next.y).toBeCloseTo(cam.y, 9);
  });
});

