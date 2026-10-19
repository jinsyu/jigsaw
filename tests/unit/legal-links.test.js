import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RtError } from '../../public/js/rt-client.js';
import { AGREE_TEXT, TERMS_REQUIRED, TERMS_URL, startErrorMessage } from '../../public/js/teacher/start-view.js';

// Plan P3: 조각조각 시작하기 records core.profiles.terms_agreed_at (the shared gyosil terms), so the
// one consent box names the terms as well as the privacy policy, and both can be read from there.
// The app has no terms page of its own: the gyosil portal's terms apply.
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const startView = read('public/js/teacher/start-view.js');

describe('terms links', () => {
  it('the shared terms live on the portal', () => {
    expect(TERMS_URL).toBe('https://gyosil.app/terms');
  });

  it('the first screen footer links the terms next to the privacy policy', () => {
    const footer = read('public/index.html').match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(footer).toContain('<a href="/privacy">개인정보 처리방침</a>\n      <a href="https://gyosil.app/terms" target="_blank" rel="noopener">이용약관</a>');
  });

  it('시작하기: one box for the terms and the privacy policy, with both to read below it', () => {
    expect(AGREE_TEXT).toBe('이용약관과 개인정보 처리방침을 읽었고 동의해요.');
    expect(startView.match(/type: 'checkbox'/g)).toHaveLength(1);
    expect(startView).toContain("{ class: 't-read-link', href: TERMS_URL, target: '_blank', rel: 'noopener' }, '이용약관 읽기'");
    expect(startView).toContain("{ class: 't-read-link', href: '/privacy', target: '_blank', rel: 'noopener' }, '개인정보 처리방침 읽기'");
    // No link inside the box's label: a tap on a link must not tick the box.
    const label = startView.slice(startView.indexOf("{ class: 't-agree'"), startView.indexOf("{ class: 't-read'"));
    expect(label).not.toContain("'a'");
  });

  it('asks for both when the box is not ticked, on the screen and from the server', () => {
    expect(TERMS_REQUIRED).toBe('이용약관과 개인정보 처리방침에 동의해 주세요.');
    expect(startErrorMessage(new RtError('terms_required', 400))).toBe(TERMS_REQUIRED);
  });

  it('the privacy policy names the terms agreement time the server records', () => {
    expect(read('server/src/teacher/teachers.js')).toContain('terms_agreed_at: new Date().toISOString()');
    expect(read('public/privacy.html')).toContain('약관 동의 시각(교실 앱 공용)');
  });
});
