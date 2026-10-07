import { describe, expect, it } from 'vitest';
import { rng } from '../../public/js/puzzle/geometry.js';
import { dealEvenly, shuffle, shuffledPieces } from '../../public/js/puzzle/deal.js';
import { shuffledPieces as fromLocalStore } from '../../public/js/store/local-store.js';

const counts = (dealt) => Object.values(dealt).map((list) => list.length).sort((a, b) => b - a);

describe('shuffledPieces (moved from local-store.js)', () => {
  it('local-store.js still exports the same function', () => {
    expect(fromLocalStore).toBe(shuffledPieces);
  });

  it('keeps the old order for a seed (demo and remote-store tray order unchanged)', () => {
    // Recorded before the move: the same Fisher-Yates walk over rng(seed).
    const next = rng(42);
    const order = Array.from({ length: 24 }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    expect(shuffledPieces(24, 42)).toEqual(order);
  });
});

describe('shuffle', () => {
  it('returns a permutation and leaves the input alone', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input, rng(7));
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual(input);
  });
});

describe('dealEvenly', () => {
  it('24 pieces to 5 empty trays: 5, 5, 5, 5, 4', () => {
    const takers = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, count: 0 }));
    const dealt = dealEvenly(Array.from({ length: 24 }, (_, i) => i), takers, rng(1));
    expect(counts(dealt)).toEqual([5, 5, 5, 5, 4]);
    expect(Object.values(dealt).flat().sort((x, y) => x - y)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it('gives first to the takers with the fewest pieces', () => {
    const dealt = dealEvenly([10, 11], [{ id: 'full', count: 3 }, { id: 'none', count: 0 }, { id: 'one', count: 1 }], rng(3));
    expect(dealt.full).toEqual([]);
    expect(dealt.none).toHaveLength(1);
    expect(dealt.one).toHaveLength(1);
  });

  it('with no takers deals nothing', () => {
    expect(dealEvenly([1, 2], [], rng(1))).toEqual({});
  });
});
