// The privacy page lists where every outside built-in picture comes from (공공누리
// 제1유형 requires the source line; public domain and CC0 pictures are credited too).
// The list is static HTML (the CSP allows no inline script) between two marker comments,
// rewritten from public/images/builtin/index.json by scripts/builtin-images.mjs so the
// page and the pictures never disagree. No institution logos (공공누리 forbids implying
// endorsement).
export const START = '<!-- builtin-credits:start (scripts/builtin-images.mjs writes this part) -->';
export const END = '<!-- builtin-credits:end -->';

const SELF_MADE = '자체 제작';
const GROUPS = ['명화', '우리 그림', '사진', '삽화'];

const escape = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderCredits(images) {
  const selfMade = images.filter((i) => i.category === SELF_MADE);
  const outside = images.filter((i) => i.category !== SELF_MADE);
  const lines = [
    `<p>수업 만들기에서 고를 수 있는 내장 그림은 ${images.length}장입니다. ${selfMade.length}장은 함께 퍼즐이 직접 그린 그림이고, ${outside.length}장은 저작권이 끝났거나(퍼블릭 도메인) 자유 이용이 허락된(CC0, 공공누리 제1유형) 명화·우리 옛 그림·사진·삽화입니다. 수업에 자유롭게 쓸 수 있습니다.</p>`,
  ];
  for (const group of GROUPS) {
    const items = outside.filter((i) => i.category === group);
    if (!items.length) continue;
    lines.push(`<h3>${escape(group)}</h3>`, '<ul class="doc-list doc-credits">');
    for (const i of items) {
      lines.push(
        `<li>${escape(i.credit)}${i.note ? ` (${escape(i.note)})` : ''} — <a href="${escape(i.source.url)}">원본</a> · <a href="${escape(i.license.url)}">라이선스</a></li>`,
      );
    }
    lines.push('</ul>');
  }
  return lines.map((line) => `    ${line}`).join('\n');
}

export function withCredits(html, images) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error('privacy.html: builtin-credits markers not found');
  return `${html.slice(0, a + START.length)}\n${renderCredits(images)}\n    ${html.slice(b)}`;
}
