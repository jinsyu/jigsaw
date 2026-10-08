import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicPath = (p) => new URL(`../../public${p}`, import.meta.url);
const index = JSON.parse(readFileSync(publicPath('/images/builtin/index.json'), 'utf8'));

// WebP files start with "RIFF....WEBP".
function readWebpHeader(path) {
  const bytes = readFileSync(publicPath(path));
  return bytes.subarray(0, 4).toString('latin1') + bytes.subarray(8, 12).toString('latin1');
}

const CATEGORIES = ['사진', '삽화', '명화', '우리 그림'];
const TOPICS = ['동물', '자연', '우주·과학', '사람·생활', '명소·건축', '탈것', '꽃·식물', '바다', '계절', '전통', '상상·이야기'];
const LEVELS = ['쉬움', '보통', '어려움'];

describe('built-in pictures index', () => {
  const outside = index.images;

  it('has a version and only outside pictures (no drawings of our own), each key once', () => {
    expect(index.version).toBe(1);
    expect(index.images.length).toBeGreaterThanOrEqual(30);
    expect(new Set(index.images.map((i) => i.key)).size).toBe(index.images.length);
    expect(index.images.filter((i) => i.source.name === '함께 퍼즐 자체 제작')).toEqual([]);
  });

  it('sorts every picture into a kind, a theme and a level', () => {
    for (const i of index.images) {
      expect(CATEGORIES, i.key).toContain(i.category);
      expect(TOPICS, i.key).toContain(i.topic);
      expect(LEVELS, i.key).toContain(i.level);
    }
    for (const c of CATEGORIES) expect(index.images.filter((i) => i.category === c).length, c).toBeGreaterThanOrEqual(3);
  });

  it.each(outside.map((i) => [i.key, i]))('%s (outside) says who made it, where it is from and its licence', (_, i) => {
    expect(i.source.author.length).toBeGreaterThan(0);
    expect(i.source.url).toMatch(/^https:\/\/(commons\.wikimedia\.org\/wiki\/File:|www\.museum\.go\.kr\/)/);
    expect(['퍼블릭 도메인', 'CC0 1.0', '공공누리 제1유형 (출처표시)']).toContain(i.license.name);
    expect(i.license.url).toMatch(/^https:\/\//);
    // The credit names the work as its holder does (the card title may be friendlier for children).
    expect(i.credit.split(',')[0].length).toBeGreaterThan(0);
    expect(i.credit).toContain(i.license.name.split(' (')[0]);
    expect(typeof i.year).toBe('string');
    expect(i.holder.length).toBeGreaterThan(0);
    // Long side 1800, own proportions within what the puzzle grid handles well.
    // (busy pictures are made a little smaller to stay under the file size limit)
    expect(Math.max(i.width, i.height)).toBeLessThanOrEqual(1800);
    expect(Math.max(i.width, i.height)).toBeGreaterThanOrEqual(1260);
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
