import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import {
  KEEP_VISIBLE_PX,
  MAX_START_PIECE_PX,
  MIN_PIECE_PX,
  VIEW_PADDING,
  boardToScreen,
  clampCamera,
  clampScale,
  fitCamera,
  fitScale,
  pinchCamera,
  scaleLimits,
  screenToBoard,
  visibleBoardRect,
  zoomAt,
} from '../../public/js/play/camera.js';

const layout = layoutFor(6, 4, 1.5); // picture 600 x 400, board ~849 x 566
const phone = { viewW: 360, viewH: 560 };
const tablet = { viewW: 788, viewH: 690 };

describe('fitScale', () => {
  it('shows the whole board when pieces stay big enough (tablet)', () => {
    const scale = fitScale(tablet, layout);
    expect(layout.boardWidth * scale).toBeLessThanOrEqual(tablet.viewW);
    expect(layout.boardHeight * scale).toBeLessThanOrEqual(tablet.viewH);
    expect(layout.pw * scale).toBeGreaterThanOrEqual(MIN_PIECE_PX);
  });

  it('fills the height of a tall phone view and leaves the sides to panning', () => {
    const scale = fitScale(phone, layout);
    expect(layout.boardHeight * scale).toBeCloseTo(phone.viewH - 2 * VIEW_PADDING, 9);
    expect(layout.boardWidth * scale).toBeGreaterThan(phone.viewW);
    expect(layout.pw * scale).toBeGreaterThanOrEqual(MIN_PIECE_PX);
  });

  it('caps the first piece size on very tall views', () => {
    const tall = { viewW: 700, viewH: 1200 };
    expect(layout.pw * fitScale(tall, layout)).toBeCloseTo(MAX_START_PIECE_PX, 9);
  });

  it('zooms a small wide view in toward finger sized pieces, up to filling it (phone on its side)', () => {
    const side = { viewW: 430, viewH: 320 }; // whole board would give 48px pieces
    const scale = fitScale(side, layout);
    expect(layout.pw * scale).toBeGreaterThan(50);
    expect(layout.boardHeight * scale).toBeCloseTo(side.viewH - 2 * VIEW_PADDING, 9);
  });

  it('never zooms in past filling a wide view with the board', () => {
    const tiny = { viewW: 120, viewH: 90 };
    const scale = fitScale(tiny, layout);
    expect(layout.boardWidth * scale).toBeLessThanOrEqual(tiny.viewW);
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

  it('clamps zoom to the limits and keeps part of the board visible', () => {
    const { min, max } = scaleLimits(phone, layout);
    expect(clampCamera({ scale: 100, x: 0, y: 0 }, phone, layout).scale).toBe(max);
    expect(clampCamera({ scale: 0.0001, x: 0, y: 0 }, phone, layout).scale).toBe(min);

    const cam = clampCamera({ scale: 1, x: 5000, y: -5000 }, phone, layout);
    expect(cam.x).toBe(phone.viewW - KEEP_VISIBLE_PX);
    expect(cam.y + layout.boardHeight).toBe(KEEP_VISIBLE_PX);
  });

  it('reports the visible part of the board', () => {
    const cam = { scale: 1, x: -100, y: -50 };
    expect(visibleBoardRect(cam, { viewW: 300, viewH: 200 }, layout)).toEqual({ x0: 100, y0: 50, x1: 400, y1: 250 });
    const all = visibleBoardRect(fitCamera(tablet, layout), tablet, layout);
    expect(all.x0).toBe(0);
    expect(all.x1).toBe(layout.boardWidth);
  });
});
