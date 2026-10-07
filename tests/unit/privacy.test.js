import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../../public/privacy.html', import.meta.url), 'utf8');
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('privacy policy (public/privacy.html, spec D14·D15)', () => {
  it('names what is collected from teachers and that student names are not stored', () => {
    expect(text).toContain('구글 계정 이메일');
    expect(text).toContain('교사가 올린 그림');
    expect(text).toContain('학생 이름은 서버에 저장하지 않습니다');
    expect(text).toContain('익명 접속 번호');
  });

  it('gives the retention periods of the spec data table', () => {
    expect(text).toContain('수업이 끝나고 30일 뒤 삭제');
    expect(text).toContain('늦어도 24시간 뒤 자동 삭제');
    expect(text).toContain('1년 동안 수업에 쓰지 않은 그림');
    expect(text).toContain('탈퇴할 때까지');
  });

  it('explains how to delete, who processes the data, and that there are no ads or analytics', () => {
    for (const phrase of ['내 그림 지우기', '수업 끝내기', '자동 정리', '교사 탈퇴']) expect(text).toContain(phrase);
    for (const company of ['Supabase', 'Vercel', 'jsDelivr', 'Google']) expect(text).toContain(company);
    expect(text).toContain('광고와 외부 분석 도구는 쓰지 않습니다');
    expect(text).toContain('학습지원 소프트웨어');
  });

  it('marks what the operator still has to fill in', () => {
    expect(html).toContain('data-todo="effective-date"'); // date written at T14
    expect(html).toContain('data-todo="server-region"'); // Supabase region not decided yet
  });

  it('gives the contact address the operator chose to publish, and no other e-mail', () => {
    const CONTACT = 'jinsyu.com@gmail.com';
    expect(html).toContain(`href="mailto:${CONTACT}"`);
    const addresses = [...text.matchAll(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi)].map((m) => m[0]);
    expect(addresses.length).toBeGreaterThan(0);
    expect(new Set(addresses)).toEqual(new Set([CONTACT]));
  });
});
