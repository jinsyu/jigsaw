import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicPath = (p) => new URL(`../../public${p}`, import.meta.url);
const index = JSON.parse(readFileSync(publicPath('/images/builtin/index.json'), 'utf8'));

// WebP files start with "RIFF....WEBP".
function readWebpHeader(path) {
  const bytes = readFileSync(publicPath(path));
  return bytes.subarray(0, 4).toString('latin1') + bytes.subarray(8, 12).toString('latin1');
}

describe('built-in pictures index', () => {
  it('has a version and the six mockup scenes for now', () => {
    expect(index.version).toBe(1);
    expect(index.images.map((i) => i.key)).toEqual(['sea', 'village', 'space', 'garden', 'classroom', 'friends']);
  });

  it.each(index.images.map((i) => [i.key, i]))('%s is a valid built-in picture', (key, image) => {
    expect(key).toMatch(/^[a-z0-9-]{1,64}$/); // sessions.builtin_key check
    expect(image.title.length).toBeGreaterThan(0);
    expect(image.category.length).toBeGreaterThan(0);
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2000);
    expect(image.source).toBeTruthy();
    expect(image.license).toBeTruthy();
    for (const path of [image.src, image.thumb]) {
      expect(path).toMatch(new RegExp(`^/images/builtin/${key}(-thumb)?\\.webp$`));
      expect(readWebpHeader(path)).toBe('RIFFWEBP');
    }
    expect(statSync(publicPath(image.thumb)).size).toBeLessThan(80_000);
    expect(statSync(publicPath(image.src)).size).toBeLessThan(400_000);
  });
});
