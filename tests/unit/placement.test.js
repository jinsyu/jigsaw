import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { frameRect } from '../../public/js/play/frame.js';
import { freeSpot } from '../../public/js/play/placement.js';

const layout = layoutFor(6, 4, 1.5); // pw = ph = 100, board ~849 x 566
const frame = frameRect(layout); // ~(124, 83) - (724, 483)
const wholeBoard = { x0: -60, y0: -40, x1: layout.boardWidth + 60, y1: layout.boardHeight + 40 }; // desktop
const phoneView = { x0: frame.x0 - 20, y0: -90, x1: frame.x1 + 20, y1: layout.boardHeight + 90 }; // frame fills the width

const cellRect = (origin, [col, row]) => {
  const left = origin.x + col * layout.pw;
  const top = origin.y + row * layout.ph;
  return { left, top, right: left + layout.pw, bottom: top + layout.ph };
};

function frameOverlap({ left, top, right, bottom }) {
  const w = Math.max(0, Math.min(right, frame.x1) - Math.max(left, frame.x0));
  const h = Math.max(0, Math.min(bottom, frame.y1) - Math.max(top, frame.y0));
  return (w * h) / (layout.pw * layout.ph);
}

function gapToFrame({ left, top, right, bottom }) {
  const dx = Math.max(frame.x0 - right, left - frame.x1, 0);
  const dy = Math.max(frame.y0 - bottom, top - frame.y1, 0);
  return Math.hypot(dx, dy);
}

const centre = ({ left, top }) => [left + layout.pw / 2, top + layout.ph / 2];

// Taps pieces out one after another, like a student emptying the tray.
function placeMany(view, cells) {
  const clusters = [];
  for (const cell of cells) {
    const origin = freeSpot(layout, view, clusters, cell, frame);
    clusters.push({ x: origin.x, y: origin.y, pieces: [cell] });
  }
  return clusters.map((c) => cellRect(c, c.pieces[0]));
}

describe('freeSpot', () => {
  it('keeps the first piece off the frame, right next to it', () => {
    const rect = cellRect(freeSpot(layout, wholeBoard, [], [2, 1], frame), [2, 1]);
    expect(frameOverlap(rect)).toBe(0);
    expect(gapToFrame(rect)).toBeLessThan(layout.pw / 2);
  });

  it('on a phone (frame fills the width) uses the bands above and below the frame', () => {
    const rect = cellRect(freeSpot(layout, phoneView, [], [3, 2], frame), [3, 2]);
    expect(frameOverlap(rect)).toBeLessThanOrEqual(0.2);
    expect(rect.bottom <= frame.y0 + 20 || rect.top >= frame.y1 - 20).toBe(true);
    expect(rect.left).toBeGreaterThanOrEqual(phoneView.x0);
    expect(rect.right).toBeLessThanOrEqual(phoneView.x1);
  });

  it('lines the next pieces up around the frame without covering each other', () => {
    const cells = [
      [0, 0],
      [3, 1],
      [5, 3],
      [1, 2],
      [4, 0],
    ];
    for (const view of [wholeBoard, phoneView]) {
      const rects = placeMany(view, cells);
      for (const rect of rects) expect(frameOverlap(rect)).toBeLessThanOrEqual(0.2);
      for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          const [ax, ay] = centre(rects[a]);
          const [bx, by] = centre(rects[b]);
          expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThanOrEqual(1.5 * layout.pw - 1e-9);
        }
      }
    }
  });

  it('when only the inside of the frame is visible, stays in view and off its own place', () => {
    const zoomedIn = { x0: frame.x0 + 100, y0: frame.y0 + 50, x1: frame.x0 + 450, y1: frame.y0 + 330 };
    for (const cell of [
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
    ]) {
      const rect = cellRect(freeSpot(layout, zoomedIn, [], cell, frame), cell);
      expect(rect.left).toBeGreaterThanOrEqual(zoomedIn.x0);
      expect(rect.right).toBeLessThanOrEqual(zoomedIn.x1);
      expect(rect.top).toBeGreaterThanOrEqual(zoomedIn.y0);
      expect(rect.bottom).toBeLessThanOrEqual(zoomedIn.y1);
      const home = [frame.x0 + (cell[0] + 0.5) * layout.pw, frame.y0 + (cell[1] + 0.5) * layout.ph];
      const [cx, cy] = centre(rect);
      expect(Math.hypot(cx - home[0], cy - home[1])).toBeGreaterThanOrEqual(layout.pw);
    }
  });

  it('keeps the piece cell inside a small visible area', () => {
    const small = { x0: 300, y0: 200, x1: 520, y1: 330 };
    const rect = cellRect(freeSpot(layout, small, [], [5, 3], frame), [5, 3]);
    expect(rect.left).toBeGreaterThanOrEqual(300);
    expect(rect.right).toBeLessThanOrEqual(520);
    expect(rect.top).toBeGreaterThanOrEqual(200);
    expect(rect.bottom).toBeLessThanOrEqual(330);
  });

  it('leaves room for the tabs at the screen edge, but may use the board edge', () => {
    const view = { x0: 200, y0: 150, x1: 700, y1: 450 }; // all inside the board
    const clusters = [{ x: 400, y: 250, pieces: [[0, 0]] }];
    const rect = cellRect(freeSpot(layout, view, clusters, [0, 0]), [0, 0]);
    expect(rect.left).toBeGreaterThanOrEqual(235);
    expect(rect.top).toBeGreaterThanOrEqual(185);
    expect(rect.right).toBeLessThanOrEqual(665);
    expect(rect.bottom).toBeLessThanOrEqual(415);

    // Board wider than the screen part: the cell stays on the board.
    const [first] = placeMany(wholeBoard, [[0, 0]]);
    expect(first.left).toBeGreaterThanOrEqual(0);
    expect(first.top).toBeGreaterThanOrEqual(0);
    expect(first.right).toBeLessThanOrEqual(layout.boardWidth);
    expect(first.bottom).toBeLessThanOrEqual(layout.boardHeight);
  });

  it('moves away from pieces already on the board', () => {
    const visible = { x0: 0, y0: 0, x1: 800, y1: 500 };
    const clusters = [{ x: 0, y: 0, pieces: [[0, 0], [1, 0], [0, 1], [1, 1]] }]; // top-left corner
    const rect = cellRect(freeSpot(layout, visible, clusters, [0, 0]), [0, 0]);
    const [cx, cy] = centre(rect);
    for (const [col, row] of clusters[0].pieces) {
      expect(Math.hypot(cx - (col + 0.5) * 100, cy - (row + 0.5) * 100)).toBeGreaterThanOrEqual(150);
    }
  });
});
