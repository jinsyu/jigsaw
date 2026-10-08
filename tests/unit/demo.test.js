import { describe, expect, it } from 'vitest';
import { createDemoStore, demoPieceCount } from '../../public/js/play/demo.js';

const WIDE = { src: '/images/builtin/wide.webp', width: 1800, height: 1200 };

describe('demo piece count (/play?demo=1&pieces=...)', () => {
  it('takes 12, 24, 48, 70 or 96 from the address', () => {
    for (const n of [12, 24, 48, 70, 96]) expect(demoPieceCount(`?demo=1&pieces=${n}`)).toBe(n);
  });

  it('falls back to 24 for anything else', () => {
    for (const search of ['?demo=1', '?demo=1&pieces=', '?demo=1&pieces=13', '?demo=1&pieces=abc', '?demo=1&pieces=-24', '?demo=1&pieces=24.5', '?demo=1&pieces=1e9']) {
      expect(demoPieceCount(search)).toBe(24);
    }
  });

  it('deals every piece into the tray', () => {
    for (const n of [12, 24, 48, 70, 96]) {
      const state = createDemoStore(n, {}, WIDE).getState();
      expect(state.tray).toHaveLength(n);
      expect(new Set(state.tray).size).toBe(n);
      expect(state.layout.cols * state.layout.rows).toBe(n);
      expect(state.progress.total).toBe(n);
    }
  });
});

describe('demo help settings (&preview=1&outline=0&button=0&underlay=1)', () => {
  it('reads only 1 and 0, the rest stays default', async () => {
    const { demoHints } = await import('../../public/js/play/demo.js');
    expect(demoHints('?demo=1')).toEqual({});
    expect(demoHints('?demo=1&preview=1&outline=0&button=0&underlay=1')).toEqual({
      preview: true,
      outline: false,
      pictureButton: false,
      underlay: true,
    });
    expect(demoHints('?preview=yes&outline=true&button=&underlay=2')).toEqual({});
    expect(demoHints('?picture=0')).toEqual({}); // picture is the picture key, not the button
  });

  it('puts the settings in the store state, with defaults filled in', () => {
    expect(createDemoStore(24, {}, WIDE).getState().hints).toEqual({ preview: false, outline: true, pictureButton: true, underlay: false });
    expect(createDemoStore(24, { preview: true, underlay: true }, WIDE).getState().hints).toEqual({
      preview: true,
      outline: true,
      pictureButton: true,
      underlay: true,
    });
  });
});

describe('demo picture (&picture=<key>)', () => {
  it('reads a built-in key, anything missing or malformed gives none (the default)', async () => {
    const { demoPictureKey } = await import('../../public/js/play/demo.js');
    expect(demoPictureKey('?demo=1')).toBeNull();
    expect(demoPictureKey('?demo=1&picture=great-wave')).toBe('great-wave');
    expect(demoPictureKey('?demo=1&picture=')).toBeNull();
    expect(demoPictureKey('?demo=1&picture=Giraffe')).toBeNull();
    expect(demoPictureKey('?demo=1&picture=../x')).toBeNull();
  });

  it('loads the picture of a key, or the first built-in picture for none or an unknown key', async () => {
    const { loadDemoPicture } = await import('../../public/js/play/demo.js');
    const index = { images: [
      { key: 'a', src: '/a.webp', width: 1800, height: 1200, credit: 'A' },
      { key: 'b', src: '/b.webp', width: 1200, height: 1800, credit: 'B' },
    ] };
    const fetchImpl = async () => ({ ok: true, json: async () => index });
    expect(await loadDemoPicture('b', fetchImpl)).toEqual({ src: '/b.webp', width: 1200, height: 1800, credit: 'B' });
    expect(await loadDemoPicture(null, fetchImpl)).toEqual({ src: '/a.webp', width: 1800, height: 1200, credit: 'A' });
    expect(await loadDemoPicture('zzz', fetchImpl)).toMatchObject({ src: '/a.webp' });
  });

  it('lays a portrait picture out as a portrait puzzle', () => {
    const state = createDemoStore(24, {}, { src: '/images/builtin/tall.webp', width: 1200, height: 1800 }).getState();
    expect(state.layout.cols).toBeLessThan(state.layout.rows);
    expect(state.picture.src).toBe('/images/builtin/tall.webp');
  });
});
