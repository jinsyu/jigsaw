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
  const selfMade = index.images.filter((i) => i.category === '자체 제작');
  const outside = index.images.filter((i) => i.category !== '자체 제작');

  it('has a version and 50 pictures: 20 self-made (the six mockup scenes first) and 30 outside', () => {
    expect(index.version).toBe(1);
    expect(index.images).toHaveLength(50);
    expect(new Set(index.images.map((i) => i.key)).size).toBe(50);
    expect(selfMade).toHaveLength(20);
    expect(selfMade.slice(0, 6).map((i) => i.key)).toEqual(['sea', 'village', 'space', 'garden', 'classroom', 'friends']);
    for (const i of selfMade) {
      expect(i.source.name).toBe('함께 퍼즐 자체 제작');
      expect(i.topic.length).toBeGreaterThan(0); // the old theme (자연, 학교, ...)
      // 3:2 landscape (1800 x 1200) or 2:3 portrait (1200 x 1800).
      expect(i.width > i.height ? '1800x1200' : '1200x1800').toBe(`${i.width}x${i.height}`);
    }
    const portrait = selfMade.filter((i) => i.height > i.width);
    expect(portrait.length).toBeGreaterThanOrEqual(2);
    expect(portrait.length).toBeLessThanOrEqual(3);
  });

  it('sorts the outside pictures into the agreed groups', () => {
    const count = (c) => outside.filter((i) => i.category === c).length;
    expect(outside).toHaveLength(30);
    expect({ 명화: count('명화'), '우리 그림': count('우리 그림'), 사진: count('사진'), 삽화: count('삽화') }).toEqual({
      명화: 12,
      '우리 그림': 9,
      사진: 6,
      삽화: 3,
    });
  });

  it.each(outside.map((i) => [i.key, i]))('%s (outside) says who made it, where it is from and its licence', (_, i) => {
    expect(i.source.author.length).toBeGreaterThan(0);
    expect(i.source.url).toMatch(/^https:\/\/(commons\.wikimedia\.org\/wiki\/File:|www\.museum\.go\.kr\/)/);
    expect(['퍼블릭 도메인', 'CC0 1.0', '공공누리 제1유형 (출처표시)']).toContain(i.license.name);
    expect(i.license.url).toMatch(/^https:\/\//);
    expect(i.credit).toContain(i.title.split(' (')[0]);
    expect(i.credit).toContain(i.license.name.split(' (')[0]);
    expect(typeof i.year).toBe('string');
    expect(i.holder.length).toBeGreaterThan(0);
    // Long side 1800, own proportions within what the puzzle grid handles well.
    expect(Math.max(i.width, i.height)).toBe(1800);
    const aspect = Math.max(i.width, i.height) / Math.min(i.width, i.height);
    expect(aspect).toBeLessThanOrEqual(2.25);
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
    expect(statSync(publicPath(image.src)).size).toBeLessThanOrEqual(500_000);
  });
});
