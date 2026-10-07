import { describe, expect, it } from 'vitest';
import { hooksAllowed } from '../../public/js/test-hooks.js';

describe('test hooks (window.__puzzle, __puzzleDemo, __overview)', () => {
  it('exist only where the site uses the local Supabase stack', () => {
    for (const host of ['localhost', '127.0.0.1', '192.168.0.12', 'mac.local']) expect(hooksAllowed(host), host).toBe(true);
    for (const host of ['jigsaw.gyosil.app', 'jigsaw-git-main.vercel.app', 'example.com']) expect(hooksAllowed(host), host).toBe(false);
  });
});
