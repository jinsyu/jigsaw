import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cardDetail, normalizeSearch, pictureSearchText } from '../../public/js/teacher/create-view.js';

const index = JSON.parse(readFileSync(new URL('../../public/images/builtin/index.json', import.meta.url), 'utf8'));

describe('built-in picture card note', () => {
  it('shows the theme (or the kind) when neither maker nor year is known', () => {
    expect(cardDetail({ category: '사진', topic: '동물', source: {} })).toBe('동물');
    expect(cardDetail({ category: '사진' })).toBe('사진');
  });

  it('shows the artist and year for outside pictures', () => {
    expect(cardDetail(index.images.find((i) => i.key === 'starry-night'))).toBe('빈센트 반 고흐, 1889');
    expect(cardDetail(index.images.find((i) => i.key === 'hyangwonjeong'))).toBe('명소·건축'); // a photo: what it shows
  });

  it('never leaves a card without a note', () => {
    for (const image of index.images) expect(cardDetail(image).length).toBeGreaterThan(0);
  });
});

describe('built-in picture search', () => {
  const find = (query) => index.images.filter((i) => pictureSearchText(i).includes(normalizeSearch(query))).map((i) => i.key);

  it('finds pictures by title, theme, kind, maker and year, ignoring spaces and case', () => {
    expect(find('바다')).toContain('great-wave');
    expect(find('반고흐')).toEqual(expect.arrayContaining(['starry-night', 'sunflowers']));
    expect(find('반 고흐')).toEqual(find('반고흐'));
    expect(find('동물')).toEqual(expect.arrayContaining(['magpie-tiger', 'monarch-butterfly']));
    expect(find('우리 그림')).toContain('ssireum');
    expect(find('1889')).toContain('starry-night');
    // tags: words that are not in the title
    expect(find('공룡')).toEqual(expect.arrayContaining(['triceratops-park', 'knight-stegosaurus']));
    expect(find('로봇')).toContain('robonaut');
  });

  it('finds nothing for words no picture has', () => {
    expect(find('없는그림이름')).toEqual([]);
  });
});
