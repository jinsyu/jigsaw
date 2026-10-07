import { describe, expect, it } from 'vitest';
import { formatDuration, teamLine } from '../../public/js/student/celebrate.js';
import { membersFromMates } from '../../public/js/student/puzzle.js';

describe('formatDuration', () => {
  it('reads like the mockup: minutes and seconds', () => {
    expect(formatDuration(760_000)).toBe('12분 40초');
    expect(formatDuration(40_400)).toBe('40초');
    expect(formatDuration(180_000)).toBe('3분');
    expect(formatDuration(3_900_000)).toBe('1시간 5분');
    expect(formatDuration(7_200_000)).toBe('2시간');
    expect(formatDuration(-5)).toBe('0초');
    expect(formatDuration(Number.NaN)).toBe('0초');
  });
});

describe('teamLine', () => {
  it('joins the names with the right particle on the last one', () => {
    expect(teamLine(['민준', '서연', '지호', '유나'])).toBe('민준 · 서연 · 지호 · 유나가 함께 맞췄어요');
    expect(teamLine(['유나', '민준'])).toBe('유나 · 민준이 함께 맞췄어요');
  });

  it('without two names it does not single anyone out', () => {
    expect(teamLine(['민준'])).toBe('모둠 친구들과 함께 맞췄어요');
    expect(teamLine([])).toBe('모둠 친구들과 함께 맞췄어요');
  });
});

describe('membersFromMates', () => {
  it('keeps the name seen earlier for a friend who left, otherwise 친구', () => {
    const seen = new Map();
    const here = [
      { id: 1, uid: 'a', name: '나', color: 0, online: true, me: true },
      { id: 2, uid: 'b', name: '서연', color: 1, online: true, me: false },
    ];
    expect(membersFromMates(here, seen)).toEqual([
      { uid: 'a', name: '나', color: 0, online: true },
      { uid: 'b', name: '서연', color: 1, online: true },
    ]);
    const later = [
      { ...here[0] },
      { ...here[1], name: null, online: false },
      { id: 3, uid: 'c', name: null, color: 2, online: false, me: false },
    ];
    expect(membersFromMates(later, seen)).toEqual([
      { uid: 'a', name: '나', color: 0, online: true },
      { uid: 'b', name: '서연', color: 1, online: false },
      { uid: 'c', name: '친구', color: 2, online: false },
    ]);
  });
});
