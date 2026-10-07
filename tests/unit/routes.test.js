import { describe, expect, it } from 'vitest';
import { matchRoute, normalizeCode } from '../../public/js/routes.js';

describe('matchRoute', () => {
  it.each([
    ['/', 'home'],
    ['/join', 'join'],
    ['/play', 'play'],
    ['/teacher', 'teacher'],
    ['/teacher/new', 'teacher'],
    ['/teacher/', 'teacher'],
    ['/teachers', 'notFound'],
    ['/nope', 'notFound'],
  ])('%s -> %s', (path, name) => {
    expect(matchRoute(path)).toBe(name);
  });
});

describe('normalizeCode', () => {
  it('keeps at most six digits', () => {
    expect(normalizeCode('48 29-13a7')).toBe('482913');
    expect(normalizeCode(undefined)).toBe('');
  });
});
