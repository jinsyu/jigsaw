import { describe, expect, it } from 'vitest';
import { PRACTICE_THEMES, practicePicks, practiceUrl } from '../../public/js/home-practice.js';
import { demoPictureKey, demoPieceCount } from '../../public/js/play/demo.js';

const pic = (key, level) => ({ key, level });

describe('home 혼자 맞춰 보기', () => {
  it('picks the asked number of pictures, easy ones before hard ones', () => {
    const images = [pic('h1', '어려움'), pic('e1', '쉬움'), pic('n1', '보통'), pic('e2', '쉬움'), pic('h2', '어려움')];
    const picks = practicePicks(images, 3, () => 0);
    expect(picks.map((p) => p.key)).toEqual(['e1', 'e2', 'n1']);
    expect(practicePicks(images, 10)).toHaveLength(5);
  });

  it('links to the solo puzzle with the picture and piece count', () => {
    const url = practiceUrl('great-wave', 24);
    expect(url).toBe('/play?demo=1&picture=great-wave&pieces=24');
    const search = url.slice(url.indexOf('?'));
    expect(demoPictureKey(search)).toBe('great-wave');
    expect(demoPieceCount(search)).toBe(24);
  });
});

describe('home 혼자 맞춰 보기 themes', () => {
  const theme = (label) => PRACTICE_THEMES.find((t) => t.label === label).test;
  it('puts dinosaurs under 공룡, not under 동물', () => {
    const dino = { topic: '동물', tags: ['공룡'] };
    const puppy = { topic: '동물' };
    expect(theme('공룡')(dino)).toBe(true);
    expect(theme('동물')(dino)).toBe(false);
    expect(theme('동물')(puppy)).toBe(true);
    expect(theme('전체')(puppy)).toBe(true);
  });
});
