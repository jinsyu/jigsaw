// 내 수업: open sessions (tap to see the code and QR again) and recently ended ones.
import { listSessions } from './data.js';
import { h, icon, setTitle } from './dom.js';
import { formatCode, formatDateTime, hintsSummary, statusLabel } from './format.js';
import { loadBuiltins, loadMyImages, sessionPicture } from './pictures.js';
import { sessionPath } from './routes.js';

const SKELETON_COUNT = 3;

export function renderHome(main, ctx) {
  ctx.setBar('nav', { active: 'home' });
  setTitle('내 수업');
  const body = h('div', { class: 't-home-body', 'aria-live': 'polite' });
  main.append(
    h(
      'div',
      { class: 't-wrap' },
      h(
        'div',
        { class: 't-head' },
        h(
          'div',
          {},
          h('h1', { tabindex: '-1' }, '내 수업'),
          h('p', { class: 'sub' }, '열려 있는 수업을 누르면 코드와 QR을 다시 볼 수 있어요.'),
        ),
        h('a', { class: 'btn pri t-head-action', href: '/teacher/new' }, icon('plus'), '새 수업 만들기'),
      ),
      body,
    ),
  );

  let alive = true;
  async function load() {
    body.setAttribute('aria-busy', 'true');
    body.replaceChildren(skeleton());
    try {
      const [sessions, builtins] = await Promise.all([listSessions(ctx.api), loadBuiltins()]);
      const myImages = sessions.some((s) => s.imageId) ? await loadMyImages(ctx.api) : [];
      if (!alive) return;
      body.replaceChildren(...sessionLists(sessions, builtins, myImages));
    } catch (error) {
      console.error(error);
      if (!alive) return;
      body.replaceChildren(
        h(
          'div',
          { class: 'card t-empty', role: 'alert' },
          h('h2', {}, '수업 목록을 불러오지 못했어요'),
          h('p', { class: 'sub' }, '인터넷 연결을 확인하고 다시 시도해 주세요.'),
          h('button', { class: 'btn', type: 'button', onclick: load }, icon('refresh'), '다시 시도'),
        ),
      );
    } finally {
      body.removeAttribute('aria-busy');
    }
  }
  load();
  return () => {
    alive = false;
  };
}

function skeleton() {
  return h(
    'ul',
    { class: 't-sessions', 'aria-label': '수업 목록을 불러오는 중이에요' },
    Array.from({ length: SKELETON_COUNT }, () => h('li', { class: 'card t-session t-skel-card' }, h('span', { class: 't-skel' }))),
  );
}

function sessionLists(sessions, builtins, myImages) {
  if (!sessions.length) return [emptyState()];
  const open = sessions.filter((s) => s.status !== 'ended');
  const past = sessions.filter((s) => s.status === 'ended');
  const out = [];

  out.push(
    h(
      'section',
      { class: 't-section', 'aria-labelledby': 't-open-title' },
      h('h2', { id: 't-open-title', class: 't-section-title' }, '열린 수업', h('span', {}, `${open.length}개`)),
      open.length
        ? h('ul', { class: 't-sessions' }, open.map((s) => h('li', {}, openCard(s, builtins, myImages))))
        : h('p', { class: 't-empty-line' }, '지금 열린 수업이 없어요. ‘새 수업 만들기’로 수업을 열어 보세요.'),
    ),
  );

  if (past.length) {
    out.push(
      h(
        'section',
        { class: 't-section', 'aria-labelledby': 't-past-title' },
        h('h2', { id: 't-past-title', class: 't-section-title' }, '지난 수업', h('span', {}, `${past.length}개`)),
        h('ul', { class: 'card t-past' }, past.map((s) => pastRow(s, builtins, myImages))),
        h('p', { class: 't-note' }, '끝난 수업은 30일 뒤에 저절로 지워져요.'),
      ),
    );
  }
  return out;
}

function openCard(session, builtins, myImages) {
  const picture = sessionPicture(session, builtins, myImages);
  return h(
    'a',
    { class: 'card t-session', href: sessionPath(session.id), 'data-code': session.code },
    thumb(picture),
    h(
      'span',
      { class: 't-session-body' },
      h('span', { class: 't-session-title' }, picture.title),
      h(
        'span',
        { class: 't-session-meta' },
        `${session.pieceCount}조각 · ${session.groupCount}모둠 · `,
        h('span', { class: 't-nowrap' }, `${formatDateTime(session.createdAt)}에 만듦`),
      ),
      h('span', { class: 't-session-hints' }, hintsSummary(session.hints)),
      h(
        'span',
        { class: 't-session-row' },
        h('span', { class: `pill ${session.status === 'playing' ? 'ok' : 'pri'}` }, statusLabel(session.status)),
        h('span', { class: 't-session-code' }, h('span', { class: 'sr-only' }, '수업 코드 '), formatCode(session.code)),
      ),
    ),
    icon('arrow'),
  );
}

function pastRow(session, builtins, myImages) {
  const picture = sessionPicture(session, builtins, myImages);
  return h(
    'li',
    {},
    h('span', { class: 't-past-title' }, picture.title),
    h('span', { class: 't-past-meta' }, `${session.pieceCount}조각 · ${session.groupCount}모둠`),
    h('span', { class: 't-past-date' }, `${formatDateTime(session.endedAt ?? session.createdAt)}에 끝남`),
  );
}

function thumb(picture) {
  if (!picture.thumb) return h('span', { class: 't-session-thumb t-thumb-none' }, icon('image', 28));
  return h('img', { class: 't-session-thumb', src: picture.thumb, alt: '', width: 120, height: 80, loading: 'lazy' });
}

function emptyState() {
  return h(
    'section',
    { class: 'card t-empty t-empty-big' },
    h('img', { src: '/images/hero.svg', alt: '', width: 120, height: 120 }),
    h('h2', {}, '아직 만든 수업이 없어요'),
    h('p', { class: 'sub' }, '그림과 조각 수, 모둠 수만 고르면 바로 수업 코드가 나와요.'),
    h('a', { class: 'btn pri', href: '/teacher/new' }, icon('plus'), '첫 수업 만들기'),
  );
}
