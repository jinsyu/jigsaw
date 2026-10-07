import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { END, START, withCredits } from '../../scripts/lib/privacy-credits.mjs';

const html = readFileSync(new URL('../../public/privacy.html', import.meta.url), 'utf8');
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('privacy policy (public/privacy.html, spec D14·D15)', () => {
  it('names what is collected from teachers and that student names are not stored', () => {
    expect(text).toContain('구글 계정 이메일');
    expect(text).toContain('교사가 올린 그림');
    expect(text).toContain('학생 이름은 서버에 저장하지 않습니다');
    expect(text).toContain('무작위 학생 번호');
  });

  it('students: no account (anonymous ones included), the name only in the rt server memory and on the device (D14)', () => {
    expect(text).toContain('학생 계정(익명 계정 포함)을 만들지 않습니다');
    expect(text).toContain('수업 중에만 실시간 서버의 메모리에 있고');
    expect(text).toContain('학생 기기의 브라우저에 남습니다');
    expect(text).not.toMatch(/익명 접속 번호|익명 로그인/);
  });

  it('IP addresses: only in memory for request limits, never logged; server logs kept 14 days', () => {
    expect(text).toContain('IP 주소는 실시간 서버가 지나친 요청을 막는 데(요청 수 제한)만 메모리에서 쓰고');
    expect(text).toContain('14일');
  });

  it('gives the retention periods of the spec data table', () => {
    expect(text).toContain('수업이 끝나고 30일 뒤 삭제');
    expect(text).toContain('늦어도 24시간 뒤 자동 삭제');
    expect(text).toContain("퍼즐 그림, '내 그림' 목록 교사가 지울 때까지");
    expect(text).not.toMatch(/1년|쓰지 않은 그림/);
    expect(text).toContain('탈퇴할 때까지');
  });

  it('explains how to delete, who processes the data, and that there are no ads or analytics', () => {
    for (const phrase of ['내 그림 지우기', '수업 끝내기', '자동 정리', '교사 탈퇴']) expect(text).toContain(phrase);
    for (const company of ['Supabase', 'Vercel', 'AWS Lightsail', 'jsDelivr', 'Google']) expect(text).toContain(company);
    expect(text).toContain('광고와 외부 분석 도구는 쓰지 않습니다');
    expect(text).toContain('학습지원 소프트웨어');
  });

  it('names the places of processing (D15): Vercel, AWS Lightsail Seoul, Supabase Seoul', () => {
    expect(text).toContain('AWS Lightsail 서울');
    expect(text).toContain('Supabase 서울');
    expect(text).toContain('Vercel(서울 지역 우선');
    expect(html).not.toContain('data-todo="server-region"');
  });

  it('teacher withdrawal deletes the jigsaw data only, not the shared gyosil account', () => {
    expect(text).toContain('함께 퍼즐의 데이터(함께 퍼즐 시작 기록, 올린 그림 파일, 수업 기록)를 모두 지웁니다');
    expect(text).toContain('다른 교실 앱과 함께 쓰는 구글 로그인 계정과 교사 이름은 그대로 두며');
  });

  it('jsDelivr serves the font only (no script from a CDN)', () => {
    expect(text).toContain('글꼴(Pretendard) 파일 전달');
    expect(text).not.toContain('서버 연결 도구');
  });

  it('leaves only the start date for the operator to fill in (written on the day of the public launch)', () => {
    expect(html).toContain('data-todo="effective-date"');
    expect([...html.matchAll(/data-todo="([^"]+)"/g)].map((m) => m[1])).toEqual(['effective-date']);
  });

  it('gives the contact address the operator chose to publish, and no other e-mail', () => {
    const CONTACT = 'jinsyu.com@gmail.com';
    expect(html).toContain(`href="mailto:${CONTACT}"`);
    const addresses = [...text.matchAll(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi)].map((m) => m[0]);
    expect(addresses.length).toBeGreaterThan(0);
    expect(new Set(addresses)).toEqual(new Set([CONTACT]));
  });

  describe('built-in picture sources (section 6)', () => {
    const index = JSON.parse(readFileSync(new URL('../../public/images/builtin/index.json', import.meta.url), 'utf8'));
    const section = html.slice(html.indexOf(START), html.indexOf(END));
    const outside = index.images.filter((i) => i.category !== '자체 제작');
    const selfMade = index.images.filter((i) => i.category === '자체 제작');
    const escape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    it('is exactly what scripts/builtin-images.mjs writes from index.json (nothing out of step)', () => {
      expect(withCredits(html, index.images)).toBe(html);
    });

    it('gives the counts of index.json', () => {
      expect(section).toContain(`내장 그림은 ${index.images.length}장입니다`);
      expect(section).toContain(`${selfMade.length}장은 함께 퍼즐이 직접 그린 그림`);
      expect(section).toContain(`${outside.length}장은`);
    });

    it.each(outside.map((i) => [i.key, i]))('credits %s with its source and licence links', (_, i) => {
      const item = section.split('<li>').find((li) => li.startsWith(escape(i.credit)));
      expect(item, i.credit).toBeTruthy();
      expect(item).toContain(`<a href="${escape(i.source.url)}">원본</a>`);
      expect(item).toContain(`<a href="${escape(i.license.url)}">라이선스</a>`);
    });

    it('shows no institution logos or other images in the list', () => {
      expect(section).not.toMatch(/<img|logo/i);
    });
  });
});

