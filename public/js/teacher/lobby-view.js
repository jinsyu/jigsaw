// Session lobby (mockup teacher-lobby): the join address, the 6-digit code and a QR,
// large enough to read from the back of the classroom on an interactive whiteboard.
// The grouping panel on the right is filled in by T9 (names, drag into groups, start).
import { endSession, getSession } from './data.js';
import { h, icon, setTitle } from './dom.js';
import { formatCode, sessionSummary, statusLabel } from './format.js';
import { loadBuiltins, loadMyImages, sessionPicture } from './pictures.js';
import { joinUrl, qrSvg } from './qr.js';

export function renderLobby(main, ctx, { sessionId }) {
  let alive = true;
  ctx.setBar('lobby', { nodes: [] });
  setTitle('수업 대기실');
  main.append(h('p', { class: 't-loading', role: 'status' }, '수업을 불러오는 중이에요…'));

  async function load() {
    try {
      const session = await getSession(ctx.client, sessionId);
      if (!alive) return;
      if (!session) return showMessage(main, ctx, '이 수업을 찾을 수 없어요', '지워졌거나 다른 선생님의 수업이에요.');
      if (session.status === 'ended') {
        return showMessage(main, ctx, '이미 끝난 수업이에요', '이 코드로는 더 이상 들어올 수 없어요. 새 수업을 열어 주세요.', true);
      }
      const builtins = await loadBuiltins();
      const myImages = session.image_id ? await loadMyImages(ctx.client) : [];
      if (!alive) return;
      showLobby(main, ctx, session, sessionPicture(session, builtins, myImages));
    } catch (error) {
      console.error(error);
      if (!alive) return;
      main.replaceChildren(
        h(
          'div',
          { class: 't-wrap' },
          h(
            'section',
            { class: 'card t-empty', role: 'alert' },
            h('h1', { tabindex: '-1' }, '수업을 불러오지 못했어요'),
            h('p', { class: 'sub' }, '인터넷 연결을 확인하고 다시 시도해 주세요.'),
            h('button', { class: 'btn', type: 'button', onclick: () => (main.replaceChildren(), load()) }, icon('refresh'), '다시 시도'),
          ),
        ),
      );
    }
  }
  load();
  return () => {
    alive = false;
  };
}

function showMessage(main, ctx, title, text, offerNew = false) {
  ctx.setBar('lobby', { nodes: [h('span', { class: 'spacer' }), h('a', { class: 'btn', href: '/teacher' }, '내 수업')] });
  setTitle(title);
  main.replaceChildren(
    h(
      'div',
      { class: 't-wrap' },
      h(
        'section',
        { class: 'card t-empty' },
        h('h1', { tabindex: '-1' }, title),
        h('p', { class: 'sub' }, text),
        h(
          'div',
          { class: 't-actions' },
          h('a', { class: 'btn', href: '/teacher' }, '내 수업으로'),
          offerNew ? h('a', { class: 'btn pri', href: '/teacher/new' }, icon('plus'), '새 수업 만들기') : null,
        ),
      ),
    ),
  );
}

function showLobby(main, ctx, session, picture) {
  document.documentElement.classList.add('is-lobby');
  const summary = sessionSummary({ title: picture.title, pieceCount: session.piece_count, groupCount: session.groups.length });
  setTitle(`수업 코드 ${session.code}`);

  const dialog = closeDialog(ctx, session);
  ctx.setBar('lobby', {
    nodes: [
      h('span', { class: 'pill t-summary' }, summary),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn t-bar-btn', href: '/teacher' }, icon('back', 18), '내 수업'),
      h('button', { class: 'btn t-bar-btn', type: 'button', onclick: () => dialog.showModal() }, '수업 닫기'),
    ],
  });

  const url = joinUrl(location.origin, session.code);
  const join = h(
    'section',
    { class: 'card t-join', 'aria-labelledby': 't-join-title' },
    h('h1', { class: 'sr-only', id: 't-join-title', tabindex: '-1' }, `${picture.title} 수업 대기실`),
    h('p', { class: 't-join-k' }, '태블릿에서 이 주소를 열고 코드를 넣어요'),
    h('p', { class: 't-join-url' }, location.host),
    h('p', { class: 't-join-code', 'data-code': session.code }, h('span', { class: 'sr-only' }, '수업 코드 '), formatCode(session.code)),
    h('div', { class: 't-join-qr', 'data-url': url, html: qrSvg(url, `입장 QR 코드: ${url}`) }),
    h('p', { class: 't-join-note' }, 'QR 코드를 찍으면 코드를 넣지 않아도 돼요'),
    h(
      'p',
      { class: 't-join-wait', role: 'status' },
      h('i', { class: 'dot t-pulse' }),
      session.status === 'playing' ? statusLabel('playing') : '학생들이 들어오기를 기다리고 있어요',
    ),
  );

  // Placeholder for T9: the names and group boxes appear here.
  const grouping = h(
    'section',
    { class: 't-grouping', 'aria-labelledby': 't-grouping-title', 'data-slot': 'grouping' },
    h(
      'div',
      { class: 't-grouping-head' },
      h('h2', { id: 't-grouping-title' }, '모둠 편성'),
      h('p', { class: 'sub' }, '이름을 모둠 칸으로 끌어 놓거나, 무작위로 나눠요.'),
    ),
    h(
      'div',
      { class: 'card t-pool' },
      h('h3', {}, '아직 모둠이 없는 학생', h('span', {}, '0명')),
      h('p', { class: 't-empty-line' }, '학생이 코드를 넣고 들어오면 여기에 이름이 나타나요.'),
    ),
    h(
      'ul',
      { class: 't-groups' },
      session.groups.map((g) =>
        h(
          'li',
          { class: 'card t-group' },
          h('h3', {}, `${g.number}모둠`, h('span', {}, '0명')),
          h('p', { class: 't-empty-line' }, '아직 학생이 없어요'),
        ),
      ),
    ),
  );

  main.replaceChildren(h('div', { class: 't-lobby' }, join, grouping), dialog);
}

function closeDialog(ctx, session) {
  const error = h('p', { class: 't-error', role: 'alert' });
  const confirm = h('button', { class: 'btn danger', type: 'button' }, '수업 닫기');
  const cancel = h('button', { class: 'btn', type: 'button', autofocus: true }, '취소');
  const dialog = h(
    'dialog',
    { class: 't-dialog', 'aria-labelledby': 't-close-title' },
    h('h2', { id: 't-close-title' }, '수업을 닫을까요?'),
    h('p', { class: 'sub' }, '닫으면 이 코드로 더 이상 들어올 수 없고, 학생들의 퍼즐도 끝나요.'),
    error,
    h('div', { class: 't-actions' }, cancel, confirm),
  );
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    error.textContent = '';
  });
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    confirm.textContent = '닫는 중…';
    try {
      await endSession(ctx.client, session.id);
      dialog.close();
      ctx.navigate('/teacher');
    } catch (err) {
      console.error(err);
      error.textContent = '수업을 닫지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';
      confirm.disabled = false;
      confirm.textContent = '수업 닫기';
    }
  });
  return dialog;
}
