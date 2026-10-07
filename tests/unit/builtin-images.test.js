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
  it('has a version and 20 pictures: the six mockup scenes first, landscape and a few portrait', () => {
    expect(index.version).toBe(1);
    expect(index.images).toHaveLength(20);
    expect(index.images.slice(0, 6).map((i) => i.key)).toEqual(['sea', 'village', 'space', 'garden', 'classroom', 'friends']);
    expect(new Set(index.images.map((i) => i.key)).size).toBe(20);
    const portrait = index.images.filter((i) => i.height > i.width);
    expect(portrait.length).toBeGreaterThanOrEqual(2);
    expect(portrait.length).toBeLessThanOrEqual(3);
    for (const i of index.images) {
      // 3:2 landscape (1800 x 1200) or 2:3 portrait (1200 x 1800).
      expect([`${i.width}x${i.height}`]).toContain(i.width > i.height ? '1800x1200' : '1200x1800');
      expect(i.source.name).toBe('함께 퍼즐 자체 제작'); // no outside artwork yet
    }
  });

  it.each(index.images.map((i) => [i.key, i]))('%s is a valid built-in picture', (key, image) => {
    expect(key).toMatch(/^[a-z0-9-]{1,64}$/); // sessions.builtin_key check
    expect(image.title.length).toBeGreaterThan(0);
    expect(image.category.length).toBeGreaterThan(0);
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2000);
    // source { name, author, url } and license { name, url }; outside pictures need the author and both URLs.
    expect(image.source.name.length).toBeGreaterThan(0);
    expect(image.source.author.length).toBeGreaterThan(0);
    expect(image.license.name.length).toBeGreaterThan(0);
    const selfMade = image.source.name === '함께 퍼즐 자체 제작';
    for (const url of [image.source.url, image.license.url]) {
      if (selfMade) expect(url).toBeNull();
      else expect(url).toMatch(/^https:\/\//);
    }
    for (const path of [image.src, image.thumb]) {
      expect(path).toMatch(new RegExp(`^/images/builtin/${key}(-thumb)?\\.webp$`));
      expect(readWebpHeader(path)).toBe('RIFFWEBP');
    }
    expect(statSync(publicPath(image.thumb)).size).toBeLessThan(80_000);
    expect(statSync(publicPath(image.src)).size).toBeLessThan(400_000);
  });
});
