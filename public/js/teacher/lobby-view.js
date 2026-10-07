// Session lobby (mockup teacher-lobby): the join address, the 6-digit code and a QR, large
// enough to read from the back of the classroom on an interactive whiteboard, and the
// 모둠 편성 panel: students appear by name as they join, the teacher drags them into groups
// (or picks and places them with the keyboard), shuffles them, and starts the puzzles.
//
// Names come only from Presence on jigsaw:session:<id> and stay in this page's memory (spec D14).
// Presence keys and payloads are set by the student's browser, so a name is shown only for
// a members row of this session read from the database (student/presence.js).
import { assignMember, endSession, getSession, listMembers, randomizeGroups, startSession } from './data.js';
import { confirmDialog } from './dialogs.js';
import { h, icon, setTitle } from './dom.js';
import { formatCode, hintsSummary, sessionSummary, statusLabel } from './format.js';
import { createGroupingPanel } from './grouping.js';
import { loadBuiltins, loadMyImages, sessionPicture } from './pictures.js';
import { showOverview } from './overview-view.js';
import { joinUrl, qrSvg } from './qr.js';
import { applyGroupChanges, buildRoster } from './roster.js';
import { presenceNames } from '../student/presence.js';
import { hintsFromSession } from '../store/puzzle-store.js';
import { sessionTopic } from '../supabase-names.js';

const NETWORK_ERROR = /fetch|network|load failed/i;

function actionError(error, fallback) {
  if (!error?.code && NETWORK_ERROR.test(error?.message ?? '')) return '인터넷 연결을 확인하고 다시 해 주세요.';
  if (error?.message === 'session_ended') return '이미 끝난 수업이에요.';
  if (error?.message === 'session_not_waiting') return '이미 시작한 수업이에요.';
  if (error?.code === '42501') return '선생님 계정으로 다시 로그인해 주세요.';
  return fallback;
}

export function renderLobby(main, ctx, { sessionId }) {
  let alive = true;
  let stopLive = null;
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
      const [builtins, members] = await Promise.all([loadBuiltins(), listMembers(ctx.client, session.id)]);
      const myImages = session.image_id ? await loadMyImages(ctx.client) : [];
      if (!alive) return;
      const picture = sessionPicture(session, builtins, myImages);
      // Once the puzzles start, the lobby turns into 모둠 한눈에 보기 (T12).
      const overview = () => {
        stopLive?.();
        stopLive = showOverview(main, ctx, { session, picture, builtins, onEnded: (result) => showEnded(main, ctx, result) });
        ctx.headingReady?.();
      };
      if (session.status === 'playing') overview();
      else {
        stopLive = showLobby(main, ctx, session, picture, members, { onPlaying: () => alive && overview() });
        ctx.headingReady?.();
      }
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
      ctx.headingReady?.();
    }
  }
  load();
  return () => {
    alive = false;
    stopLive?.();
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
    `학생 화면에 ‘수업이 끝났어요’가 나왔고, 모둠 배정과 학생 익명 계정은 지워졌어요.${done}`,
    true,
  );
}

function showLobby(main, ctx, session, picture, initialMembers, { onPlaying }) {
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
  const waitDot = h('i', { class: 'dot' });
  const waitText = h('span', {});
  const waitLine = h('p', { class: 't-join-wait', role: 'status' }, waitDot, waitText);
  const join = h(
    'section',
    { class: 'card t-join', 'aria-labelledby': 't-join-title' },
    h('h1', { class: 'sr-only', id: 't-join-title', tabindex: '-1' }, `${picture.title} 수업 대기실`),
    h('p', { class: 't-join-k' }, '태블릿에서 이 주소를 열고 코드를 넣어요'),
    h('p', { class: 't-join-url' }, location.host),
    h('p', { class: 't-join-code', 'data-code': session.code }, h('span', { class: 'sr-only' }, '수업 코드 '), formatCode(session.code)),
    h('div', { class: 't-join-qr', 'data-url': url, html: qrSvg(url, `입장 QR 코드: ${url}`) }),
    h('p', { class: 't-join-note' }, 'QR 코드를 찍으면 코드를 넣지 않아도 돼요'),
    waitLine,
    h('p', { class: 't-join-hints' }, hintsSummary(hintsFromSession(session))),
  );

  let status = session.status;
  let members = initialMembers;
  let presence = {};
  let connection = 'connecting';
  const seen = new Map(); // last name seen per member, this page only
  const triedKeys = new Set();
  let alive = true;

  // Leaves the channel and drops the panel's listeners. Safe to call more than once.
  function stop() {
    if (!alive) return;
    alive = false;
    clearTimeout(grace);
    panel.destroy();
    ctx.client.removeChannel(channel).catch(() => {});
  }

  const panel = createGroupingPanel({
    groups: session.groups,
    onAssign: assign,
    onRandomize: randomize,
    onStart: start,
  });
  main.replaceChildren(h('div', { class: 't-lobby' }, join, panel.element), dialog);

  function redraw() {
    if (!alive) return;
    const { names, unknownKeys } = presenceNames(presence, members);
    for (const [id, name] of names) seen.set(id, name);
    const roster = buildRoster({ members, groups: session.groups, online: names, seen });
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
    // A Presence key we have no row for: most likely a student who just joined.
    if (unknownKeys.some((key) => !triedKeys.has(key))) {
      unknownKeys.forEach((key) => triedKeys.add(key));
      reloadMembers();
    }
  }

  let reloading = null;
  let reloadAgain = false;
  function reloadMembers() {
    if (reloading) {
      reloadAgain = true;
      return reloading;
    }
    reloading = listMembers(ctx.client, session.id)
      .then((rows) => {
        members = rows;
        redraw();
      })
      .catch((error) => console.error(error))
      .finally(() => {
        reloading = null;
        if (reloadAgain && alive) {
          reloadAgain = false;
          reloadMembers();
        }
      });
    return reloading;
  }

  function setMember(row) {
    members = members.map((m) => (m.id === row.id ? { ...m, group_id: row.group_id, color: row.color } : m));
  }

  async function assign(memberId, groupId) {
    const before = members.find((m) => m.id === memberId);
    if (!before) return;
    panel.clearError();
    // Show the move at once; the server decides the colour.
    setMember({ id: memberId, group_id: groupId, color: groupId === null ? null : before.color });
    redraw();
    try {
      setMember(await assignMember(ctx.client, memberId, groupId));
    } catch (error) {
      console.error(error);
      setMember(before);
      panel.showError(actionError(error, '옮기지 못했어요. 다시 해 주세요.'));
    }
    redraw();
  }

  async function randomize() {
    panel.clearError();
    if (members.some((m) => m.group_id !== null)) {
      const ok = await confirmDialog(main, {
        title: '모둠을 다시 나눌까요?',
        text: '지금 나눈 모둠은 사라지고, 모든 학생을 무작위로 다시 나눠요.',
        confirm: '다시 나누기',
      });
      if (!ok) return;
    }
    panel.setBusy('randomize');
    try {
      const rows = await randomizeGroups(ctx.client, session.id);
      members = members.map((m) => rows.find((r) => r.id === m.id) ?? m);
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
    const waitingCount = members.filter((m) => m.group_id === null).length;
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
      await startSession(ctx.client, session.id);
      return onPlaying();
    } catch (error) {
      console.error(error);
      if (error?.message === 'session_not_waiting') return onPlaying();
      panel.showError(actionError(error, '시작하지 못했어요. 다시 눌러 주세요.'));
    }
    panel.setBusy('');
    redraw();
  }

  // Live updates on jigsaw:session:<id>. The teacher listens only; students track their names.
  const channel = ctx.client.channel(sessionTopic(session.id), { config: { private: true } });
  channel
    .on('presence', { event: 'sync' }, () => {
      presence = channel.presenceState();
      redraw();
    })
    .on('broadcast', { event: 'groups' }, ({ payload }) => {
      const result = applyGroupChanges(members, payload?.members ?? []);
      members = result.members;
      redraw();
      if (result.missing) reloadMembers();
    })
    .on('broadcast', { event: 'start' }, () => {
      if (alive) onPlaying(); // started in another tab
    })
    .on('broadcast', { event: 'end' }, () => {
      if (!alive) return;
      stop(); // leave the channel and the drag key listener now, not only on navigation
      dialog.close();
      showMessage(main, ctx, '이미 끝난 수업이에요', '이 코드로는 더 이상 들어올 수 없어요. 새 수업을 열어 주세요.', true);
    });
  const grace = setTimeout(() => {
    if (connection === 'connecting') {
      connection = 'lost';
      redraw();
    }
  }, 6000);
  ctx.client.realtime
    .setAuth()
    .catch((error) => console.error(error))
    .then(() => {
      if (!alive) return;
      channel.subscribe((state) => {
        if (!alive) return;
        if (state === 'SUBSCRIBED') {
          connection = 'ok';
          reloadMembers(); // catch up on anything missed while connecting
        } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
          connection = 'lost';
        }
        redraw();
      });
    });

  redraw();
  return stop;
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
