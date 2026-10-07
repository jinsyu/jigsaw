import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cardDetail } from '../../public/js/teacher/create-view.js';

const index = JSON.parse(readFileSync(new URL('../../public/images/builtin/index.json', import.meta.url), 'utf8'));

describe('built-in picture card note', () => {
  it('shows the theme for self-made scenes', () => {
    expect(cardDetail(index.images.find((i) => i.key === 'sea'))).toBe('자연');
    expect(cardDetail({ category: '자체 제작' })).toBe('자체 제작');
  });

  it('shows the artist and year for outside pictures', () => {
    expect(cardDetail(index.images.find((i) => i.key === 'starry-night'))).toBe('빈센트 반 고흐, 1889');
    expect(cardDetail(index.images.find((i) => i.key === 'hyangwonjeong'))).toBe('Huntsmanleader'); // no year
  });

  it('never leaves a card without a note', () => {
    for (const image of index.images) expect(cardDetail(image).length).toBeGreaterThan(0);
  });
});
