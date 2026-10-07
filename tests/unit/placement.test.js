import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { frameRect } from '../../public/js/play/frame.js';
import { freeSpot, sideOf } from '../../public/js/play/placement.js';
import { SNAP_TOLERANCE } from '../../public/js/puzzle/snap.js';

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

  it('when the view shows only the frame, puts the piece beside the frame (off screen) rather than on it', () => {
    const small = { x0: 300, y0: 200, x1: 520, y1: 330 };
    const rect = cellRect(freeSpot(layout, small, [], [5, 3], frame), [5, 3]);
    expect(frameOverlap(rect)).toBeLessThanOrEqual(0.2);
    // Nearest such spot: just above or below the frame, in line with the view.
    expect(rect.left).toBeGreaterThanOrEqual(small.x0 - layout.pw);
    expect(rect.right).toBeLessThanOrEqual(small.x1 + layout.pw);
  });

  it('leaves room for the tabs at the screen edge, and keeps the cell on the board', () => {
    const view = { x0: 0, y0: 0, x1: 500, y1: 300 }; // top-left of the board
    const clusters = [{ x: 0, y: 0, pieces: [[0, 0]] }];
    const rect = cellRect(freeSpot(layout, view, clusters, [3, 0]), [3, 0]);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(465);
    expect(rect.bottom).toBeLessThanOrEqual(265);

    const [first] = placeMany(wholeBoard, [[0, 0]]);
    expect(first.left).toBeGreaterThanOrEqual(0);
    expect(first.top).toBeGreaterThanOrEqual(0);
    expect(first.right).toBeLessThanOrEqual(layout.boardWidth);
    expect(first.bottom).toBeLessThanOrEqual(layout.boardHeight);
  });

  it('never covers the frame, even with every piece out (phone view)', () => {
    const cells = [];
    for (let row = 0; row < layout.rows; row++) for (let col = 0; col < layout.cols; col++) cells.push([col, row]);
    const rects = placeMany(phoneView, cells);
    for (const rect of rects) {
      expect(frameOverlap(rect)).toBeLessThanOrEqual(0.2);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(layout.boardWidth);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(layout.boardHeight);
    }
    // On screen first, shared evenly by the sides in view (above and below the frame);
    // the sides beside the screen only once no clear spot is left on it.
    const inView = (r) => r.left >= phoneView.x0 && r.right <= phoneView.x1;
    const firstOff = rects.findIndex((r) => !inView(r));
    expect(firstOff).toBeGreaterThanOrEqual(4);
    const shown = rects.slice(0, firstOff).map((r) => sideOf(r.left + 50, r.top + 50, frame));
    const top = shown.filter((side) => side === 'top').length;
    const bottom = shown.filter((side) => side === 'bottom').length;
    expect(top + bottom).toBe(firstOff);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
    expect(new Set(rects.map((r) => sideOf(r.left + 50, r.top + 50, frame))).size).toBe(4);
  });

  it('never drops a piece where it would snap by accident', () => {
    const cells = [];
    for (let row = 0; row < layout.rows; row++) for (let col = 0; col < layout.cols; col++) cells.push([col, row]);
    const clusters = [];
    for (const cell of cells) {
      const o = freeSpot(layout, phoneView, clusters, cell, frame);
      expect(Math.hypot(o.x - frame.x0, o.y - frame.y0)).toBeGreaterThan(SNAP_TOLERANCE);
      for (const c of clusters) {
        const [col, row] = c.pieces[0];
        if (Math.abs(col - cell[0]) + Math.abs(row - cell[1]) === 1) {
          expect(Math.hypot(o.x - c.x, o.y - c.y)).toBeGreaterThan(SNAP_TOLERANCE);
        }
      }
      clusters.push({ x: o.x, y: o.y, pieces: [cell] });
    }
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

  describe('spreads pieces evenly around the four sides', () => {
    const allCells = (lay) => {
      const cells = [];
      for (let row = 0; row < lay.rows; row++) for (let col = 0; col < lay.cols; col++) cells.push([col, row]);
      // A shuffled but fixed order, like a tray.
      return cells.sort((a, b) => ((a[0] * 7 + a[1] * 13) % 11) - ((b[0] * 7 + b[1] * 13) % 11));
    };
    const countSides = (lay, fr, origins) => {
      const count = { top: 0, right: 0, bottom: 0, left: 0 };
      for (const { o, cell } of origins) {
        count[sideOf(o.x + (cell[0] + 0.5) * lay.pw, o.y + (cell[1] + 0.5) * lay.ph, fr)] += 1;
      }
      return count;
    };
    const place = (lay, fr, view, cells) => {
      const clusters = [];
      const origins = [];
      for (const cell of cells) {
        const o = freeSpot(lay, view, clusters, cell, fr);
        clusters.push({ x: o.x, y: o.y, pieces: [cell] });
        origins.push({ o, cell });
      }
      return origins;
    };
    // The board size comes from the layout: the same rule for a 2x and a 3x board.
    const boardOf = (lay, k) => ({ ...lay, boardWidth: lay.width * Math.sqrt(k), boardHeight: lay.height * Math.sqrt(k) });

    for (const k of [2, 3]) {
      it(`${k}x board: the four sides take turns while there is room`, () => {
        const lay = boardOf(layoutFor(6, 4, 1.5), k);
        const fr = frameRect(lay);
        const view = { x0: -50, y0: -50, x1: lay.boardWidth + 50, y1: lay.boardHeight + 50 };
        const origins = place(lay, fr, view, allCells(lay).slice(0, 8));
        const count = Object.values(countSides(lay, fr, origins));
        // 3x: exact turns. 2x: the side bands are barely a piece wide, so off by one at most.
        if (k === 3) expect(count).toEqual([2, 2, 2, 2]);
        else expect(Math.max(...count) - Math.min(...count)).toBeLessThanOrEqual(2);
        expect(Math.min(...count)).toBeGreaterThanOrEqual(1);
        for (const { o, cell } of origins) {
          const left = o.x + cell[0] * lay.pw;
          const top = o.y + cell[1] * lay.ph;
          expect(left).toBeGreaterThanOrEqual(0);
          expect(top).toBeGreaterThanOrEqual(0);
          expect(left + lay.pw).toBeLessThanOrEqual(lay.boardWidth);
          expect(top + lay.ph).toBeLessThanOrEqual(lay.boardHeight);
        }
      });
    }

    it('3x board: all 24 pieces evenly (no side more than 2 ahead), none on the frame', () => {
      const lay = boardOf(layoutFor(6, 4, 1.5), 3);
      const fr = frameRect(lay);
      const view = { x0: -50, y0: -50, x1: lay.boardWidth + 50, y1: lay.boardHeight + 50 };
      const origins = place(lay, fr, view, allCells(lay));
      const count = Object.values(countSides(lay, fr, origins));
      expect(count.reduce((a, b) => a + b, 0)).toBe(24);
      expect(Math.max(...count) - Math.min(...count)).toBeLessThanOrEqual(2);
    });

    it('classifies points by the side of the frame they are beside', () => {
      const fr = { x0: 100, y0: 100, x1: 300, y1: 200 };
      expect(sideOf(200, 50, fr)).toBe('top');
      expect(sideOf(350, 150, fr)).toBe('right');
      expect(sideOf(200, 260, fr)).toBe('bottom');
      expect(sideOf(20, 150, fr)).toBe('left');
      expect(sideOf(90, 20, fr)).toBe('top'); // corner: farther out from the top
      expect(sideOf(200, 150, fr)).toBeNull();
    });
  });
});

