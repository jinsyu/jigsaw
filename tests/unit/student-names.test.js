// T10 (contest-2026 DoD 4): student names must not carry contact details or banned words.
// The same check runs on the screen and on the rt server (join and socket connect).
import { describe, expect, it } from 'vitest';
import { nameProblem, normalizeName } from '../../public/js/student/names.js';
import { safeName } from '../../server/src/sockets.js';

const check = (value) => nameProblem(normalizeName(value));

describe('nameProblem', () => {
  it.each(['민준', '3번', '15번 하늘', '별님2', 'Luna', '2026 토끼', '😀', '새끼손가락', 'Essex', '2026.10.15', '2026-10-15'])('allows %j', (name) => {
    expect(check(name)).toBeNull();
  });

  it.each([
    '010-1234-5678',
    '01012345678',
    '010 1234 5678',
    '010.1234',
    '０１０１２３４５６７８',
    '02-123-4567',
    '900101-1234567',
    '9001011234567',
    'kim@naver.com',
    'a＠b.kr',
    '민준 010-1234',
  ])('refuses %j as personal_info', (name) => {
    expect(check(name)).toBe('personal_info');
  });

  it.each(['바보', '바 보', '바1보', '멍청이', 'SHIT', 'ㅅㅂ', 'ㅅ ㅂ', 'ㅅ1ㅂ', '새끼곰', 's e x', 'f-u-c-k'])('refuses %j as banned_word', (name) => {
    expect(check(name)).toBe('banned_word');
  });

  it.each(['김민준', '김 민준', '이서연', '박지우', '최하은7', '남궁민', '남궁민수', '제갈 현우', '황보 준'])('refuses %j as real_name', (name) => {
    expect(check(name)).toBe('real_name');
  });

  it.each(['하하하', '구미호', '오리온', '오소리', '지하철', '우주선', '도라지', '유리수', '원주민', '강아지', '고양이', '김밥', '토끼왕', '다솜이', '한결이', '김민준이에요', 'Kim'])(
    'allows %j (not a surname + given-name shape)',
    (name) => {
      expect(check(name)).toBeNull();
    },
  );

  it('treats anything that is not a string as no problem (normalizeName empties it first)', () => {
    expect(nameProblem(undefined)).toBeNull();
  });
});

describe('safeName (socket connect after a server restart)', () => {
  it('keeps a fine name, normalized', () => {
    expect(safeName('  민준 ')).toBe('민준');
  });

  it('drops a name the join check would refuse', () => {
    expect(safeName('010-1234-5678')).toBe('');
    expect(safeName('바보')).toBe('');
    expect(safeName('김민준')).toBe('');
  });
});
