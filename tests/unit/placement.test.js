import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { freeSpot } from '../../public/js/play/placement.js';

const layout = layoutFor(6, 4, 1.5); // pw = ph = 100
const visible = { x0: 0, y0: 0, x1: 800, y1: 500 };

const cellRect = (origin, [col, row]) => ({
  left: origin.x + col * layout.pw,
  top: origin.y + row * layout.ph,
});

describe('freeSpot', () => {
  it('puts the piece cell near the middle of an empty view', () => {
    const origin = freeSpot(layout, visible, [], [2, 1]);
    const { left, top } = cellRect(origin, [2, 1]);
    expect(Math.abs(left + 50 - 400)).toBeLessThanOrEqual(50);
    expect(Math.abs(top + 50 - 250)).toBeLessThanOrEqual(50);
  });

  it('keeps the piece cell inside the visible area', () => {
    const small = { x0: 300, y0: 200, x1: 520, y1: 330 };
    const { left, top } = cellRect(freeSpot(layout, small, [], [5, 3]), [5, 3]);
    expect(left).toBeGreaterThanOrEqual(300);
    expect(left + 100).toBeLessThanOrEqual(520);
    expect(top).toBeGreaterThanOrEqual(200);
    expect(top + 100).toBeLessThanOrEqual(330);
  });

  it('leaves room for the tabs at the view edge', () => {
    const clusters = [{ x: 400, y: 250, pieces: [[0, 0]] }];
    const { left, top } = cellRect(freeSpot(layout, visible, clusters, [0, 0]), [0, 0]);
    expect(left).toBeGreaterThanOrEqual(35);
    expect(top).toBeGreaterThanOrEqual(35);
  });

  it('moves away from pieces already on the board', () => {
    const clusters = [{ x: 0, y: 0, pieces: [[0, 0], [1, 0], [0, 1], [1, 1]] }]; // top-left corner
    const { left, top } = cellRect(freeSpot(layout, visible, clusters, [0, 0]), [0, 0]);
    expect(left + 50).toBeGreaterThan(500);
    expect(top + 50).toBeGreaterThan(300);
  });
});
