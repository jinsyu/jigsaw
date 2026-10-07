import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import {
  HOLD_MS,
  SNAP_TOLERANCE,
  clampPosition,
  findMerges,
  frameOrigin,
  grabRefusal,
  isHeldByOther,
  progress,
  resolveDrop,
  withoutHeldByOthers,
} from '../../public/js/puzzle/snap.js';
import { NOW, expectCaseResult, hasHolds, runCase, table } from '../fixtures/snap-case.js';

describe('snap-cases.json', () => {
  it('has at least 15 cases with unique names', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(15);
    const names = table.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('shares the default tolerance with snap.js', () => {
    expect(table.defaultTolerance).toBe(SNAP_TOLERANCE);
    expect(SNAP_TOLERANCE).toBe(40);
  });

  describe.each(table.cases)('$name', ({ input, expected }) => {
    it('matches the expected merge result', () => {
      expectCaseResult(runCase(input), expected);
    });

    it('does not change the input', () => {
      const before = JSON.stringify(input);
      runCase(input);
      expect(JSON.stringify(input)).toBe(before);
    });

    it.runIf(!hasHolds(input))('gives the same result as plain resolveDrop without holds', () => {
      const layout = layoutFor(input.grid.cols, input.grid.rows, input.grid.aspect);
      const plain = resolveDrop(layout, input.clusters, input.drop, input.tolerance);
      expect(runCase(input)).toEqual(plain);
    });
  });

  it('has hold cases on both sides of the 10 second boundary', () => {
    const ages = table.cases.flatMap((c) => c.input.clusters.map((k) => k.heldMsAgo));
    expect(ages).toContain(HOLD_MS - 1);
    expect(ages).toContain(HOLD_MS);
  });

  it('never drops a cluster that is locked (locked clusters cannot be grabbed)', () => {
    for (const { input } of table.cases) {
      const dropped = input.clusters.find((c) => c.id === input.drop.id);
      expect(dropped.locked, input.drop.id).not.toBe(true);
    }
  });
});

describe('resolveDrop input checks', () => {
  const layout = layoutFor(4, 3, 4 / 3);

  it('throws for a locked dropped cluster (it can never be grabbed)', () => {
    const clusters = [{ id: 1, x: 0, y: 0, locked: true, pieces: [[0, 0]] }];
    expect(() => resolveDrop(layout, clusters, { id: 1, x: 10, y: 10 })).toThrow(/locked/);
  });

  it('throws for a missing dropped cluster', () => {
    expect(() => resolveDrop(layout, [], { id: 1, x: 0, y: 0 })).toThrow(/not found/);
  });
});

describe('frameOrigin', () => {
  it('centres the completed picture on the board', () => {
    const layout = layoutFor(4, 3, 4 / 3);
    const { x, y } = frameOrigin(layout);
    expect(x).toBe((layout.boardWidth - 400) / 2);
    expect(y).toBe((layout.boardHeight - layout.height) / 2);
    expect(x + layout.width / 2).toBeCloseTo(layout.boardWidth / 2, 9);
    expect(y + layout.height / 2).toBeCloseTo(layout.boardHeight / 2, 9);
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
    expect(result).toMatchObject({ id: 1, x: 100, y: 100, locked: false, absorbed: [2] });
  });

  it('throws when the dropped cluster is missing', () => {
    expect(() => findMerges([], 1, 30)).toThrow();
  });
});

describe('progress', () => {
  it('counts only pieces in locked clusters', () => {
    const clusters = [
      { id: 1, x: 0, y: 0, locked: true, pieces: [[0, 0], [1, 0], [2, 0]] },
      { id: 2, x: 0, y: 0, pieces: [[3, 2], [3, 1]] },
    ];
    expect(progress(clusters, 12)).toEqual({ placed: 3, total: 12, complete: false });
  });

  it('is complete only when every piece is locked', () => {
    const all = Array.from({ length: 12 }, (_, i) => [i % 4, Math.floor(i / 4)]);
    expect(progress([{ id: 1, x: 0, y: 0, pieces: all }], 12).complete).toBe(false);
    expect(progress([{ id: 1, x: 0, y: 0, locked: true, pieces: all }], 12).complete).toBe(true);
  });

  it('is not complete with an empty board', () => {
    expect(progress([], 12)).toEqual({ placed: 0, total: 12, complete: false });
  });
});

describe('isHeldByOther · grabRefusal', () => {
  const online = () => true;
  const held = (heldBy, ageMs) => ({ id: 1, x: 0, y: 0, pieces: [[0, 0]], heldBy, heldAt: NOW - ageMs });

  it('locks a fresh hold by a connected other student', () => {
    expect(isHeldByOther(held('amy', 0), 'me', NOW, online)).toBe(true);
    expect(isHeldByOther(held('amy', HOLD_MS - 1), 'me', NOW, online)).toBe(true);
  });

  it('frees a hold that is 10 seconds old, mine, by a disconnected student, or absent', () => {
    expect(isHeldByOther(held('amy', HOLD_MS), 'me', NOW, online)).toBe(false);
    expect(isHeldByOther(held('me', 0), 'me', NOW, online)).toBe(false);
    expect(isHeldByOther(held('amy', 0), 'me', NOW, () => false)).toBe(false);
    expect(isHeldByOther(held(null, 0), 'me', NOW, online)).toBe(false);
    expect(isHeldByOther({ id: 1, x: 0, y: 0, pieces: [[0, 0]] }, 'me', NOW, online)).toBe(false);
  });

  it('withoutHeldByOthers keeps only clusters this student may merge with', () => {
    const list = [held('amy', 0), { ...held('ben', 0), id: 2 }, { ...held(null, 0), id: 3 }];
    const kept = withoutHeldByOthers(list, 'me', NOW, (uid) => uid === 'amy');
    expect(kept.map((c) => c.id)).toEqual([2, 3]);
  });

  it('refuses locked clusters first, then clusters held by others', () => {
    expect(grabRefusal({ ...held(null, 0), locked: true }, 'me', NOW, online)).toBe('locked');
    expect(grabRefusal({ ...held('amy', 0), locked: true }, 'me', NOW, online)).toBe('locked');
    expect(grabRefusal(held('amy', 0), 'me', NOW, online)).toBe('held');
    expect(grabRefusal(held('amy', HOLD_MS), 'me', NOW, online)).toBeNull();
    expect(grabRefusal(held('me', 0), 'me', NOW, online)).toBeNull();
  });
});
