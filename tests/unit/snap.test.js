import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import {
  SNAP_TOLERANCE,
  clampPosition,
  findMerges,
  progress,
  resolveDrop,
} from '../../public/js/puzzle/snap.js';

const table = JSON.parse(
  readFileSync(new URL('../fixtures/snap-cases.json', import.meta.url), 'utf8'),
);

const POSITION_EPSILON = 1e-9;

function expectPosition(actual, expected) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(POSITION_EPSILON);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(POSITION_EPSILON);
}

function runCase({ grid, clusters, drop, tolerance }) {
  const layout = layoutFor(grid.cols, grid.rows, grid.aspect);
  return resolveDrop(layout, clusters, drop, tolerance);
}

describe('snap-cases.json', () => {
  it('has at least 15 cases with unique names', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(15);
    const names = table.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('shares the default tolerance with snap.js', () => {
    expect(table.defaultTolerance).toBe(SNAP_TOLERANCE);
  });

  describe.each(table.cases)('$name', ({ input, expected }) => {
    it('matches the expected merge result', () => {
      const result = runCase(input);
      expect(result.id).toBe(expected.id);
      expectPosition(result, expected);
      expect(result.absorbed).toEqual(expected.absorbed);
      expect(result.placed).toBe(expected.placed);
      expect(result.total).toBe(expected.total);
      expect(result.complete).toBe(expected.complete);

      expect(result.clusters.map((c) => c.id)).toEqual(expected.clusters.map((c) => c.id));
      result.clusters.forEach((c, i) => {
        const want = expected.clusters[i];
        expect(c.pieces).toEqual(want.pieces);
        expectPosition(c, want);
      });
    });

    it('does not change the input', () => {
      const before = JSON.stringify(input);
      runCase(input);
      expect(JSON.stringify(input)).toBe(before);
    });
  });
});

describe('clampPosition', () => {
  const layout = layoutFor(4, 3, 4 / 3);

  it('keeps a position that is already inside', () => {
    expect(clampPosition(layout, [[1, 1]], 10, 20)).toEqual({ x: 10, y: 20 });
  });

  it('never returns negative zero at the left/top edge', () => {
    const { x, y } = clampPosition(layout, [[0, 0]], -5, -5);
    expect(Object.is(x, 0)).toBe(true);
    expect(Object.is(y, 0)).toBe(true);
  });
});

describe('findMerges', () => {
  it('uses the stored position of the dropped cluster', () => {
    const clusters = [
      { id: 1, x: 100, y: 100, pieces: [[0, 0]] },
      { id: 2, x: 105, y: 100, pieces: [[1, 0]] },
    ];
    const result = findMerges(clusters, 2, 30);
    expect(result).toMatchObject({ id: 1, x: 100, y: 100, absorbed: [2] });
  });

  it('throws when the dropped cluster is missing', () => {
    expect(() => findMerges([], 1, 30)).toThrow();
  });
});

describe('progress', () => {
  it('counts only pieces in clusters of two or more', () => {
    const clusters = [
      { id: 1, x: 0, y: 0, pieces: [[0, 0], [1, 0], [2, 0]] },
      { id: 2, x: 0, y: 0, pieces: [[3, 2]] },
    ];
    expect(progress(clusters, 12)).toEqual({ placed: 3, total: 12, complete: false });
  });

  it('is not complete with an empty board', () => {
    expect(progress([], 12)).toEqual({ placed: 0, total: 12, complete: false });
  });
});
