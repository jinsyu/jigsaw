import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { frameOrigin, frameRect } from '../../public/js/play/frame.js';
import { SNAP_TOLERANCE, frameOrigin as snapFrameOrigin, resolveDrop } from '../../public/js/puzzle/snap.js';

describe('frame (completed picture place on the board)', () => {
  it('centres the picture on the board: T = ((boardW - W) / 2, (boardH - H) / 2)', () => {
    const layout = layoutFor(6, 4, 1.5);
    const t = frameOrigin(layout);
    expect(t.x).toBe((layout.boardWidth - layout.width) / 2);
    expect(t.y).toBe((layout.boardHeight - layout.height) / 2);
  });

  it('covers exactly the completed picture size and stays on the board', () => {
    for (const [cols, rows, aspect] of [
      [4, 3, 4 / 3],
      [6, 4, 1.5],
      [8, 6, 1],
      [7, 10, 0.75],
    ]) {
      const layout = layoutFor(cols, rows, aspect);
      const r = frameRect(layout);
      expect(r.x1 - r.x0).toBeCloseTo(layout.width, 9);
      expect(r.y1 - r.y0).toBeCloseTo(layout.height, 9);
      expect(r.x0).toBeGreaterThan(0);
      expect(r.y0).toBeGreaterThan(0);
      expect(r.x1).toBeLessThan(layout.boardWidth);
      expect(r.y1).toBeLessThan(layout.boardHeight);
      expect((r.x0 + r.x1) / 2).toBeCloseTo(layout.boardWidth / 2, 9);
      expect((r.y0 + r.y1) / 2).toBeCloseTo(layout.boardHeight / 2, 9);
    }
  });

  it('is drawn exactly where pieces snap in and lock (snap.js rule 6)', () => {
    for (const [cols, rows, aspect] of [
      [4, 3, 4 / 3],
      [6, 4, 1.5],
      [10, 7, 1.5],
      [7, 10, 0.75],
    ]) {
      const layout = layoutFor(cols, rows, aspect);
      const r = frameRect(layout);
      expect(frameOrigin(layout)).toEqual(snapFrameOrigin(layout));
      // A piece dropped a little off its drawn place lands on it and locks.
      const near = 0.9 * SNAP_TOLERANCE * Math.SQRT1_2;
      for (const [col, row] of [
        [0, 0],
        [cols - 1, rows - 1],
        [Math.floor(cols / 2), Math.floor(rows / 2)],
      ]) {
        const piece = { id: 1, x: 0, y: 0, pieces: [[col, row]] };
        const result = resolveDrop(layout, [piece], { id: 1, x: r.x0 + near, y: r.y0 - near });
        expect(result.locked).toBe(true);
        expect(result.x).toBe(r.x0);
        expect(result.y).toBe(r.y0);
      }
    }
  });
});
