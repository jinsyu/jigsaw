// Session lobby (mockup teacher-lobby): the join address, the 6-digit code and a QR, large
// enough to read from the back of the classroom on an interactive whiteboard, and the
// 모둠 편성 panel: students appear by name as they join, the teacher drags them into groups
// (or picks and places them with the keyboard), shuffles them, and starts the puzzles.
// Once the puzzles start the same page turns into 모둠 한눈에 보기 (overview-view.js).
//
// Everything live comes over the class's socket (session-live.js): names exist only in the
// rt server's memory and this page (spec D14), and arrive within a second of joining (D3).
import { listSessions } from './data.js';
import { confirmDialog } from './dialogs.js';
import { h, icon, setTitle } from './dom.js';
import { formatCode, hintsSummary, sessionSummary, statusLabel } from './format.js';
import { createGroupingPanel } from './grouping.js';
import { loadBuiltins } from './pictures.js';
import { showOverview } from './overview-view.js';
import { joinUrl, qrSvg } from './qr.js';
import { buildRoster } from './roster.js';
import { ClassActionError, connectClass } from './session-live.js';
import { normalizeHints } from '../store/puzzle-store.js';

function actionError(error, fallback) {
  if (error instanceof ClassActionError) {
    if (error.code === 'session_ended') return '이미 끝난 수업이에요.';
    if (error.code === 'session_not_waiting') return '이미 시작한 수업이에요.';
    if (error.code === 'timeout' || error.code === 'not_connected') return '서버와 연결이 끊겼어요. 다시 연결되면 한 번 더 해 주세요.';
  }
  return fallback;
}

async function pictureTitle(setup) {
  if (!setup.builtinKey) return '내 그림';
  try {
    const builtins = await loadBuiltins();
    return builtins.find((b) => b.key === setup.builtinKey)?.title ?? '그림';
  } catch {
    return '그림';
  }
}

export function renderLobby(main, ctx, { sessionId }) {
  let alive = true;
  let view = null; // { update(change), stop() } of the lobby or the overview
  let mode = null; // 'lobby' | 'overview' | 'done'
  let picture = null;
  ctx.setBar('lobby', { nodes: [] });
  setTitle('수업 대기실');
  main.append(h('p', { class: 't-loading', role: 'status' }, '수업을 불러오는 중이에요…'));

  const live = connectClass({
    rtUrl: ctx.config.rtUrl,
    token: ctx.auth.token,
    sessionId,
    onChange: (change) => alive && changed(change),
    onConnection: (status) => {
      if (!alive) return;
      ctx.setReconnecting(status === 'lost' && mode !== null && mode !== 'done');
      if (mode === 'lobby') view?.update({ kind: 'connection', status });
      if (status === 'lost' && mode === null) lostBeforeState();
    },
    onRefused: (reason) => alive && refused(reason),
  });

  let opening = false;
  async function changed(change) {
    if (mode === 'done') return;
    if (change.kind === 'end') return ended(false);
    if (mode === null) {
      if (change.kind !== 'state' || opening) return;
      opening = true;
      picture = { title: await pictureTitle(live.state.setup) };
      if (!alive) return;
      open();
      return;
    }
    if (mode === 'lobby' && live.state.status === 'playing') return toOverview();
    view?.update(change);
  }

  function open() {
    if (live.state.status === 'playing') toOverview();
    else {
      mode = 'lobby';
      view = showLobby(main, ctx, live, picture, { onPlaying: () => alive && toOverview() });
    }
    ctx.headingReady?.();
  }

  async function toOverview() {
    if (mode === 'overview' || mode === 'done') return;
    view?.stop();
    mode = 'overview';
    view = null;
    const builtins = await loadBuiltins().catch(() => []);
    if (!alive || mode !== 'overview') return;
    view = showOverview(main, ctx, { live, picture, builtins, onEnded: (result) => finish(result) });
    ctx.headingReady?.();
  }

  function finish(result) {
    mode = 'done';
    view?.stop();
    view = null;
    live.close();
    ctx.setReconnecting(false);
    showEnded(main, ctx, result);
  }

  function ended(byMe) {
    if (mode === 'overview' && view) return view.update({ kind: 'end' }); // the overview says how it went
    if (live.ending) return; // 수업 닫기 on this page: its dialog goes on to 내 수업
    finish({ byMe, doneCount: 0, activeCount: 0 });
  }

  // The server will not open this class for us: signed out, or the class is gone / not ours.
  async function refused(reason) {
    if (reason === 'invalid_token') return ctx.signOut('다시 로그인해 주세요.');
    mode = 'done';
    view?.stop();
    view = null;
    live.close();
    ctx.setReconnecting(false);
    let known = null;
    try {
      known = (await listSessions(ctx.api)).find((s) => s.id === sessionId) ?? null;
    } catch (error) {
      console.error(error);
    }
    if (!alive) return;
    if (known?.status === 'ended') {
      showMessage(main, ctx, '이미 끝난 수업이에요', '이 코드로는 더 이상 들어올 수 없어요. 새 수업을 열어 주세요.', true);
    } else {
      showMessage(main, ctx, '이 수업을 찾을 수 없어요', '지워졌거나 다른 선생님의 수업이에요.');
    }
  }

  // No answer yet and the connection failed: say so, keep trying in the background.
  function lostBeforeState() {
    const note = main.querySelector('.t-loading');
    if (note) note.textContent = '서버에 연결하지 못했어요. 다시 연결하는 중이에요…';
  }

  return () => {
    alive = false;
    view?.stop();
    live.close();
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
  ctx.headingReady?.();
}

// After 수업 끝내기 (or the class ended elsewhere): what happened, and where to go next.
function showEnded(main, ctx, { byMe, doneCount, activeCount }) {
  const done = activeCount ? ` 완성한 모둠은 ${doneCount} / ${activeCount}모둠이에요.` : '';
  showMessage(
    main,
    ctx,
    byMe ? '수업을 끝냈어요' : '이미 끝난 수업이에요',
    `학생 화면에 ‘수업이 끝났어요’가 나왔고, 모둠 배정은 지워졌어요.${done}`,
    true,
  );
}

function showLobby(main, ctx, live, picture, { onPlaying }) {
  document.documentElement.classList.add('is-lobby');
  const setup = live.state.setup;
  const hints = normalizeHints(setup.hints);
  const groups = live.state.groups.map((g) => ({ id: g.number, number: g.number }));
  const summary = sessionSummary({ title: picture.title, pieceCount: setup.pieceCount, groupCount: groups.length });
  setTitle(`수업 코드 ${setup.code}`);

  const dialog = closeDialog(ctx, live);
  ctx.setBar('lobby', {
    nodes: [
      h('span', { class: 'pill t-summary' }, summary),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn t-bar-btn', href: '/teacher' }, icon('back', 18), '내 수업'),
      h('button', { class: 'btn t-bar-btn', type: 'button', onclick: () => dialog.showModal() }, '수업 닫기'),
    ],
  });

  const url = joinUrl(location.origin, setup.code);
  const waitDot = h('i', { class: 'dot' });
  const waitText = h('span', {});
  const waitLine = h('p', { class: 't-join-wait', role: 'status' }, waitDot, waitText);
  const join = h(
    'section',
    { class: 'card t-join', 'aria-labelledby': 't-join-title' },
    h('h1', { class: 'sr-only', id: 't-join-title', tabindex: '-1' }, `${picture.title} 수업 대기실`),
    h('p', { class: 't-join-k' }, '태블릿에서 이 주소를 열고 코드를 넣어요'),
    h('p', { class: 't-join-url' }, location.host),
    h('p', { class: 't-join-code', 'data-code': setup.code }, h('span', { class: 'sr-only' }, '수업 코드 '), formatCode(setup.code)),
    h('div', { class: 't-join-qr', 'data-url': url, html: qrSvg(url, `입장 QR 코드: ${url}`) }),
    h('p', { class: 't-join-note' }, 'QR 코드를 찍으면 코드를 넣지 않아도 돼요'),
    waitLine,
    h('p', { class: 't-join-hints' }, hintsSummary(hints)),
  );

  let connection = 'ok';
  let alive = true;

  const panel = createGroupingPanel({ groups, onAssign: assign, onRandomize: randomize, onStart: start });
  main.replaceChildren(h('div', { class: 't-lobby' }, join, panel.element), dialog);

  function redraw() {
    if (!alive) return;
    const status = live.state.status;
    const roster = buildRoster({ members: live.state.members, groups });
    panel.update(roster, { status });
    const lost = connection === 'lost';
    waitDot.className = `dot${roster.onlineCount || lost ? '' : ' t-pulse'}${lost ? ' is-lost' : ''}`;
    waitText.textContent = lost
      ? '연결이 끊겼어요. 다시 연결하는 중이에요…'
      : roster.onlineCount
        ? `${status === 'playing' ? `${statusLabel('playing')} · ` : ''}들어온 학생 ${roster.onlineCount}명`
        : status === 'playing'
          ? statusLabel('playing')
          : '학생들이 들어오기를 기다리고 있어요';
  }

  async function assign(memberId, group) {
    const before = live.state.members.find((m) => m.id === memberId);
    if (!before) return;
    panel.clearError();
    // Show the move at once; the server decides the colour.
    live.model.moveLocally(memberId, group, group === null ? null : before.color);
    redraw();
    try {
      await live.assign(memberId, group);
    } catch (error) {
      console.error(error);
      live.model.moveLocally(memberId, before.group, before.color);
      panel.showError(actionError(error, '옮기지 못했어요. 다시 해 주세요.'));
    }
    redraw();
  }

  async function randomize() {
    panel.clearError();
    if (live.state.members.some((m) => m.group !== null)) {
      const ok = await confirmDialog(main, {
        title: '모둠을 다시 나눌까요?',
        text: '지금 나눈 모둠은 사라지고, 모든 학생을 무작위로 다시 나눠요.',
        confirm: '다시 나누기',
      });
      if (!ok) return;
    }
    panel.setBusy('randomize');
    try {
      await live.randomize();
      panel.announce('모든 학생을 무작위로 나눴어요.');
    } catch (error) {
      console.error(error);
      panel.showError(actionError(error, '나누지 못했어요. 다시 눌러 주세요.'));
    }
    panel.setBusy('');
    redraw();
  }

  async function start() {
    panel.clearError();
    const waitingCount = live.state.members.filter((m) => m.group === null).length;
    if (waitingCount) {
      const ok = await confirmDialog(main, {
        title: '이대로 시작할까요?',
        text: `아직 모둠이 없는 학생이 ${waitingCount}명 있어요. 시작한 뒤에도 모둠 칸으로 끌어 넣을 수 있어요.`,
        confirm: '시작하기',
        tone: 'pri',
      });
      if (!ok) return;
    }
    panel.setBusy('start');
    try {
      await live.start();
      return onPlaying();
    } catch (error) {
      console.error(error);
      if (error?.code === 'session_not_waiting') return onPlaying();
      panel.showError(actionError(error, '시작하지 못했어요. 다시 눌러 주세요.'));
    }
    panel.setBusy('');
    redraw();
  }

  redraw();
  return {
    update(change) {
      if (change?.kind === 'connection') connection = change.status === 'lost' ? 'lost' : 'ok';
      redraw();
    },
    stop() {
      if (!alive) return;
      alive = false;
      if (dialog.open) dialog.close();
      panel.destroy();
      document.documentElement.classList.remove('is-lobby');
    },
  };
}

function closeDialog(ctx, live) {
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
      await live.end();
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
