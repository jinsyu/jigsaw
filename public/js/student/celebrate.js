// Completed puzzle (mockup student-phone #5): every group member sees it, with the picture,
// the time taken and who made it. No ranks or comparisons with other groups (spec rule 8).
// Confetti is decoration only; it does not move when reduced motion is asked for (CSS).
import { h } from '../teacher/dom.js';
import { MEMBER_COLORS } from './colors.js';
import { withParticle } from './names.js';

const CONFETTI = 34;

// 760000 -> '12분 40초'; under a minute '40초'; an hour or more '1시간 5분'.
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  if (minutes > 0) return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
  return `${seconds}초`;
}

// ['민준', '서연', '유나'] -> '민준 · 서연 · 유나가 함께 맞췄어요'.
export function teamLine(names) {
  const list = names.filter(Boolean);
  if (list.length < 2) return '모둠 친구들과 함께 맞췄어요';
  const last = list.at(-1);
  return `${[...list.slice(0, -1), withParticle(last, '이', '가')].join(' · ')} 함께 맞췄어요`;
}

// Same scattering every time (no Math.random: calm, and tests can compare screenshots).
function confetti() {
  let seed = 9;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return Array.from({ length: CONFETTI }, (_, k) => {
    const i = h('i');
    const left = k % 2 ? 2 + next() * 14 : 84 + next() * 14;
    i.style.setProperty('left', `${left.toFixed(1)}%`);
    i.style.setProperty('top', `${(next() * 40).toFixed(1)}%`);
    i.style.setProperty('background', MEMBER_COLORS[k % MEMBER_COLORS.length]);
    i.style.setProperty('--turn', `${Math.round(next() * 180)}deg`);
    i.style.setProperty('--delay', `${Math.round(next() * 400)}ms`);
    return i;
  });
}

/**
 * @param {HTMLElement} main
 * @param {{ groupNumber: number, names: string[], picture: { src, width, height, credit? },
 *           durationMs: number, pieceCount: number }} info
 */
export function renderCelebration(main, { groupNumber, names, picture, durationMs, pieceCount }) {
  document.documentElement.classList.remove('is-play');
  document.title = `${groupNumber}모둠 완성! | 함께 퍼즐`;
  main.className = 'page st st-done';
  main.removeAttribute('aria-busy');
  delete main.dataset.ready;
  const img = h('img', { src: picture.src, alt: '완성한 퍼즐 그림', width: picture.width, height: picture.height });
  const heading = h('h1', { tabindex: '-1' }, `${groupNumber}모둠 완성!`);
  main.replaceChildren(
    h('div', { class: 'st-confetti', 'aria-hidden': 'true' }, confetti()),
    h('span', { class: 'pill ok st-pill' }, h('i', { class: 'dot' }), '모든 조각이 맞았어요'),
    heading,
    h('p', { class: 'sub' }, teamLine(names)),
    h('div', { class: 'st-done-img' }, img),
    picture.credit ? h('p', { class: 'st-credit' }, picture.credit) : null,
    h(
      'dl',
      { class: 'st-stats' },
      h('div', {}, h('dt', {}, '걸린 시간'), h('dd', {}, formatDuration(durationMs))),
      h('div', {}, h('dt', {}, '조각'), h('dd', {}, `${pieceCount}개`)),
    ),
    h('p', { class: 'hint' }, '선생님 화면에도 완성이 표시됐어요'),
  );
  window.scrollTo(0, 0);
  heading.focus({ preventScroll: true });
}
