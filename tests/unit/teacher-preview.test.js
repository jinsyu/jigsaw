import { describe, expect, it } from 'vitest';
import { previewOutline } from '../../public/js/teacher/preview.js';

describe('previewOutline', () => {
  it('cuts a landscape picture into the real grid of the chosen piece count', () => {
    const outline = previewOutline(24, 1800, 1200);
    expect(outline.cols).toBe(6);
    expect(outline.rows).toBe(4);
    expect(outline.width).toBe(600);
    expect(outline.height).toBe(400);
    expect(outline.paths).toHaveLength(24);
    expect(outline.paths[0]).toMatch(/^M0\.00 0\.00C/);
  });

  it('turns the grid for a portrait picture', () => {
    const outline = previewOutline(12, 900, 1200);
    expect([outline.cols, outline.rows]).toEqual([3, 4]);
    expect(outline.paths).toHaveLength(12);
  });

  it('gives the same shapes every time (fixed preview seed)', () => {
    expect(previewOutline(48, 1800, 1200).paths).toEqual(previewOutline(48, 1800, 1200).paths);
  });
});
