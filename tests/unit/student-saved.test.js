import { describe, expect, it } from 'vitest';
import { NAME_MAX, normalizeName, withParticle } from '../../public/js/student/names.js';
import { SAVED_PREFIX, clearSaved, latestSaved, readSaved, savedKey, writeSaved } from '../../public/js/student/saved.js';
import { memberColor, NEUTRAL_COLOR } from '../../public/js/student/colors.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
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

describe('saved student entry (one per class code)', () => {
  const now = 1_800_000_000_000;
  const TOKEN = 'k3J9xQ2vYw8LmN4pR7sT1uV6zA0bC5dE-fG_hI2jK3l';

  it('round-trips the name and the student token under the class code', () => {
    const storage = memoryStorage();
    writeSaved(storage, { name: ' 민준 ', code: '482913', token: TOKEN }, now);
    expect(readSaved(storage, '482913', now + 1000)).toEqual({ name: '민준', code: '482913', token: TOKEN });
    expect(JSON.parse(storage.getItem(savedKey('482913'))).v).toBe(2);
    expect(savedKey('482913')).toBe(`${SAVED_PREFIX}482913`);
    expect(readSaved(storage, '111111', now)).toBeNull();
  });

  it('drops and removes entries that are old, from the future, broken, partial or of another version', () => {
    const storage = memoryStorage();
    const key = savedKey('482913');
    const bad = [
      () => writeSaved(storage, { name: '민준', code: '482913', token: TOKEN }, now - 24 * 3600 * 1000),
      () => writeSaved(storage, { name: '민준', code: '482913', token: TOKEN }, now + 1),
      () => storage.setItem(key, '{nope'),
      () => storage.setItem(key, JSON.stringify({ v: 1, name: '민준', code: '482913', sessionId: 7, memberId: 31, savedAt: now })),
      () => storage.setItem(key, JSON.stringify({ v: 2, name: '민준', code: '999999', token: TOKEN, savedAt: now })),
      () => writeSaved(storage, { name: '  ', code: '482913', token: TOKEN }, now),
      () => writeSaved(storage, { name: '서연', code: '482913', token: 'short' }, now),
      () => writeSaved(storage, { name: '서연', code: '482913', token: '<script>'.repeat(4) }, now),
    ];
    for (const write of bad) {
      write();
      expect(readSaved(storage, '482913', now)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
    writeSaved(storage, { name: '서연', code: '12', token: TOKEN }, now);
    expect(storage.map.size).toBe(0);
  });

  it('latestSaved picks the newest class of this device and removes the old one-key entry', () => {
    const storage = memoryStorage();
    storage.setItem('jigsaw-student', JSON.stringify({ v: 1, name: '옛날' }));
    storage.setItem('other-app', 'x');
    writeSaved(storage, { name: '지호', code: '111111', token: TOKEN }, now - 5000);
    writeSaved(storage, { name: '유나', code: '222222', token: TOKEN }, now - 1000);
    writeSaved(storage, { name: '서연', code: '333333', token: TOKEN }, now - 25 * 3600 * 1000);
    expect(latestSaved(storage, now)).toEqual({ name: '유나', code: '222222', token: TOKEN });
    expect(storage.getItem('jigsaw-student')).toBeNull();
    expect(storage.getItem(savedKey('333333'))).toBeNull(); // expired: removed on the way
    expect(storage.getItem('other-app')).toBe('x');
    expect(latestSaved(memoryStorage(), now)).toBeNull();
  });

  it('clearSaved removes the name and token of that class only (the class ended)', () => {
    const storage = memoryStorage();
    writeSaved(storage, { name: '지호', code: '482913', token: TOKEN }, now);
    writeSaved(storage, { name: '지호', code: '111111', token: TOKEN }, now);
    clearSaved(storage, '482913');
    expect([...storage.map.keys()]).toEqual([savedKey('111111')]);
  });

  it('survives a storage that throws', () => {
    const broken = {
      length: 1,
      key: () => {
        throw new Error('denied');
      },
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(() => writeSaved(broken, { name: '유나', code: '482913', token: TOKEN }, now)).not.toThrow();
    expect(readSaved(broken, '482913', now)).toBeNull();
    expect(latestSaved(broken, now)).toBeNull();
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
