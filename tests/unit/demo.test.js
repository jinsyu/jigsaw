import { describe, expect, it } from 'vitest';
import { createDemoStore, demoPieceCount } from '../../public/js/play/demo.js';

describe('demo piece count (/play?demo=1&pieces=...)', () => {
  it('takes 12, 24, 48 or 70 from the address', () => {
    for (const n of [12, 24, 48, 70]) expect(demoPieceCount(`?demo=1&pieces=${n}`)).toBe(n);
  });

  it('falls back to 24 for anything else', () => {
    for (const search of ['?demo=1', '?demo=1&pieces=', '?demo=1&pieces=13', '?demo=1&pieces=abc', '?demo=1&pieces=-24', '?demo=1&pieces=24.5', '?demo=1&pieces=1e9']) {
      expect(demoPieceCount(search)).toBe(24);
    }
  });

  it('deals every piece into the tray', () => {
    for (const n of [12, 24, 48, 70]) {
      const state = createDemoStore(n).getState();
      expect(state.tray).toHaveLength(n);
      expect(new Set(state.tray).size).toBe(n);
      expect(state.layout.cols * state.layout.rows).toBe(n);
      expect(state.progress.total).toBe(n);
    }
  });
});
