import { describe, expect, it } from 'vitest';
import { NAME_MAX, normalizeName, withParticle } from '../../public/js/student/names.js';
import { SAVED_KEY, clearSaved, readSaved, writeSaved } from '../../public/js/student/saved.js';
import { memberColor, NEUTRAL_COLOR } from '../../public/js/student/colors.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

describe('normalizeName', () => {
  it('trims, folds spaces and drops hidden characters', () => {
    expect(normalizeName('  민 \n 준  ')).toBe('민 준');
    expect(normalizeName('민‮준‍')).toBe('민준');
    expect(normalizeName('\u0007')).toBe('');
  });

  it(`keeps at most ${NAME_MAX} characters, counting emoji as one`, () => {
    expect(normalizeName('가나다라마바사아자차카타')).toBe('가나다라마바사아자차');
    expect(Array.from(normalizeName('😀'.repeat(12)))).toHaveLength(NAME_MAX);
  });

  it('returns an empty string for non-strings', () => {
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName({ name: 'x' })).toBe('');
  });
});

describe('saved student entry', () => {
  const now = 1_800_000_000_000;

  it('round-trips the class and name', () => {
    const storage = memoryStorage();
    writeSaved(storage, { name: ' 민준 ', code: '482913', sessionId: 7, memberId: 31 }, now);
    expect(readSaved(storage, now + 1000)).toEqual({ name: '민준', code: '482913', sessionId: 7, memberId: 31 });
    expect(JSON.parse(storage.getItem(SAVED_KEY)).v).toBe(1);
  });

  it('drops and removes entries that are old, from the future, broken, partial or of another version', () => {
    const storage = memoryStorage();
    const bad = [
      () => writeSaved(storage, { name: '민준', code: '482913', sessionId: 7, memberId: 31 }, now - 24 * 3600 * 1000),
      () => writeSaved(storage, { name: '민준', code: '482913', sessionId: 7, memberId: 31 }, now + 1),
      () => storage.setItem(SAVED_KEY, '{nope'),
      () => storage.setItem(SAVED_KEY, JSON.stringify({ v: 2, name: '민준', savedAt: now })),
      () => writeSaved(storage, { name: '서연', code: '12', sessionId: 7, memberId: 31 }, now),
      () => writeSaved(storage, { name: '  ', code: '482913', sessionId: 7, memberId: 31 }, now),
    ];
    for (const write of bad) {
      write();
      expect(readSaved(storage, now)).toBeNull();
      expect(storage.getItem(SAVED_KEY)).toBeNull();
    }
  });

  it('clearSaved removes the name with the class (the class ended)', () => {
    const storage = memoryStorage();
    writeSaved(storage, { name: '지호', code: '482913', sessionId: 7, memberId: 31 }, now);
    clearSaved(storage);
    expect(storage.map.size).toBe(0);
  });

  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(() => writeSaved(broken, { name: '유나', code: '482913', sessionId: 1, memberId: 1 }, now)).not.toThrow();
    expect(readSaved(broken, now)).toBeNull();
  });
});

describe('memberColor', () => {
  it('cycles six colours and uses sand for no group', () => {
    expect(memberColor(0)).toBe('#F0544F');
    expect(memberColor(6)).toBe('#F0544F');
    expect(memberColor(null)).toBe(NEUTRAL_COLOR);
  });
});

describe('withParticle', () => {
  it.each([
    ['민준', '을', '를', '민준을'],
    ['유나', '을', '를', '유나를'],
    ['1모둠', '으로', '로', '1모둠으로'],
    ['서울', '으로', '로', '서울로'],
    ['Mina', '을', '를', 'Mina을(를)'],
  ])('%s + %s/%s', (word, a, b, expected) => expect(withParticle(word, a, b)).toBe(expected));
});
