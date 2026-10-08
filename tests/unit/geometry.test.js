import { describe, expect, it } from 'vitest';
import {
  PIECE_COUNTS,
  gridFor,
  layoutFor,
  makePuzzle,
  rng,
  toPath2D,
  traceOutline,
} from '../../public/js/puzzle/geometry.js';

describe('rng', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = rng(42);
    const b = rng(42);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(seqA.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it('gives a different sequence for a different seed', () => {
    expect(rng(1)()).not.toBe(rng(2)());
  });
});

describe('gridFor', () => {
  it.each([
    [12, 4, 3],
    [24, 6, 4],
    [48, 8, 6],
    [70, 10, 7],
    [96, 12, 8],
  ])('%i pieces on a landscape picture -> %ix%i', (count, cols, rows) => {
    expect(gridFor(count, 1.5)).toEqual({ cols, rows });
  });

  it('swaps columns and rows for a portrait picture', () => {
    expect(gridFor(24, 0.75)).toEqual({ cols: 4, rows: 6 });
    expect(gridFor(70, 2 / 3)).toEqual({ cols: 7, rows: 10 });
  });

  it('treats a square picture as landscape', () => {
    expect(gridFor(12, 1)).toEqual({ cols: 4, rows: 3 });
  });

  it('rejects unsupported piece counts and bad aspects', () => {
    expect(PIECE_COUNTS).toEqual([12, 24, 48, 70, 96]);
    expect(() => gridFor(13, 1.5)).toThrow();
    expect(() => gridFor(12, 0)).toThrow();
  });
});

describe('layoutFor', () => {
  it('uses 100 units per column and the picture aspect for height', () => {
    const l = layoutFor(4, 3, 4 / 3);
    expect(l).toMatchObject({ cols: 4, rows: 3, width: 400, height: 300, pw: 100, ph: 100 });
  });

  it('makes the board three times the picture area (each side sqrt(3))', () => {
    const l = layoutFor(6, 4, 1.5);
    expect(l.boardWidth).toBe(600 * Math.sqrt(3));
    expect(l.boardHeight).toBe(400 * Math.sqrt(3));
    expect((l.boardWidth * l.boardHeight) / (l.width * l.height)).toBeCloseTo(3, 12);
  });

  it('allows non-square pieces', () => {
    const l = layoutFor(4, 3, 2);
    expect(l.height).toBe(200);
    expect(l.ph).toBe(200 / 3);
  });
});

describe('makePuzzle', () => {
  const layout = layoutFor(6, 4, 1.5);

  it('makes one piece per cell in row-major order', () => {
    const pz = makePuzzle(layout, 7);
    expect(pz.pieces).toHaveLength(24);
    expect(pz.at(2, 1)).toBe(pz.pieces[1 * 6 + 2]);
    expect(pz.at(2, 1)).toMatchObject({ index: 8, col: 2, row: 1, x0: 200, y0: 100 });
  });

  it('gives the same shapes for the same seed on every device', () => {
    const a = makePuzzle(layout, 123456).pieces.map((p) => p.d);
    const b = makePuzzle(layout, 123456).pieces.map((p) => p.d);
    expect(b).toEqual(a);
  });

  it('gives different shapes for a different seed', () => {
    const a = makePuzzle(layout, 1).pieces.map((p) => p.d);
    const b = makePuzzle(layout, 2).pieces.map((p) => p.d);
    expect(b).not.toEqual(a);
  });

  it('starts and ends every outline at the cell corner', () => {
    const pz = makePuzzle(layout, 9);
    for (const p of pz.pieces) {
      const segs = p.segments;
      expect(segs[0][0]).toEqual([p.x0, p.y0]);
      expect(segs.at(-1)[3]).toEqual([p.x0, p.y0]);
      expect(p.d.startsWith('M')).toBe(true);
      expect(p.d.endsWith('Z')).toBe(true);
    }
  });

  it('makes neighbouring pieces share the same joint curve', () => {
    const pz = makePuzzle(layout, 5);
    const key = (pt) => pt.map((n) => n.toFixed(6)).join(',');
    const points = (p) => new Set(p.segments.flat().map(key));
    const a = points(pz.at(1, 1));
    const right = points(pz.at(2, 1));
    const below = points(pz.at(1, 2));
    const diagonal = points(pz.at(2, 2));
    const shared = (s) => [...s].filter((k) => a.has(k)).length;
    // A joint has 19 distinct points (6 cubic segments); corners are shared too.
    expect(shared(right)).toBeGreaterThanOrEqual(19);
    expect(shared(below)).toBeGreaterThanOrEqual(19);
    expect(shared(diagonal)).toBe(1);
  });

  it('keeps the outer border straight', () => {
    const pz = makePuzzle(layout, 3);
    const inside = (p) =>
      p.segments.flat().every(([x, y]) => x >= 0 && y >= 0 && x <= pz.width && y <= pz.height);
    expect(inside(pz.at(0, 0))).toBe(true);
    expect(inside(pz.at(5, 3))).toBe(true);
  });
});

describe('outline drawing', () => {
  it('traces cubic segments onto any canvas path target', () => {
    const pz = makePuzzle(layoutFor(4, 3, 4 / 3), 11);
    const piece = pz.at(1, 1);
    const calls = [];
    const target = {
      moveTo: (...a) => calls.push(['moveTo', ...a]),
      bezierCurveTo: (...a) => calls.push(['bezierCurveTo', ...a]),
      closePath: () => calls.push(['closePath']),
    };
    traceOutline(target, piece);
    expect(calls[0]).toEqual(['moveTo', 100, 100]);
    expect(calls.filter((c) => c[0] === 'bezierCurveTo')).toHaveLength(piece.segments.length);
    expect(calls.at(-1)).toEqual(['closePath']);
  });

  it('builds a Path2D when the browser provides one', () => {
    const made = [];
    globalThis.Path2D = class {
      constructor() {
        made.push(this);
        this.calls = 0;
      }
      moveTo() { this.calls++; }
      bezierCurveTo() { this.calls++; }
      closePath() { this.calls++; }
    };
    try {
      const piece = makePuzzle(layoutFor(4, 3, 4 / 3), 11).at(0, 0);
      const path = toPath2D(piece);
      expect(made).toEqual([path]);
      expect(path.calls).toBe(piece.segments.length + 2);
    } finally {
      delete globalThis.Path2D;
    }
  });
});
