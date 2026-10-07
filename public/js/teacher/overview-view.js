// 모둠 한눈에 보기 (mockup teacher-overview, spec F5): what the lobby turns into once the
// puzzles start. Shown on the classroom whiteboard (1920 x 1080), a tablet or a PC.
// - Every group's board as a small canvas (real frame and pieces, overview-board.js), its
//   progress (pieces locked in the frame / all), its students (online or 잠시 나감), and
//   '완성' with the time taken once done. A clock shows how long the class has been playing.
// - Refreshed by one session_overview read every POLL_MS; nothing is read while the page is
//   hidden. Names come from Presence on session:<id> only (D14), like the lobby.
// - A group card opens the big view of that group (same data). 모둠 편성 opens the lobby's
//   grouping panel (drag, or pick and place with the keyboard) for late students and moves.
// - 수업 끝내기 asks first, then end_session: students see '수업이 끝났어요', members and
//   their anonymous accounts are deleted (D14).
import { assignMember, endSession } from './data.js';
import { actionDialog } from './dialogs.js';
import { h, pieceIcon, setTitle } from './dom.js';
import { formatCode, hintsSummary } from './format.js';
import { createGroupingPanel } from './grouping.js';
import { createBoardArt, createBoardCanvas } from './overview-board.js';
import {
  POLL_MS,
  buildOverview,
  clockOffset,
  fetchOverview,
  formatClock,
  getPuzzleSetup,
  overviewColumns,
  pictureSource,
  spokenClock,
} from './overview-data.js';
import { joinUrl, qrSvg } from './qr.js';
import { formatDuration } from '../student/celebrate.js';
import { memberColor } from '../student/colors.js';
import { presenceNames } from '../student/presence.js';
import { loadPicture } from '../play/picture.js';
import { layoutFor } from '../puzzle/geometry.js';
import { hintsFromSession } from '../store/puzzle-store.js';

// After this many failed reads in a row the screen says the data may be old.
const FAILS_BEFORE_WARNING = 2;
const UNKNOWN_NAME = '이름 모름';

const svgIcon = (body, size = 20) =>
  h('span', {
    class: 't-icon',
    'aria-hidden': 'true',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  });
const ICON = {
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 3h6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.4c2.4.2 4.2 1.8 4.8 4.6"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2"/>',
};

function studentChip(student) {
  const name = student.name ?? UNKNOWN_NAME;
  const away = student.online
    ? null
    : h('em', {}, student.awayMs === null || student.awayMs >= 3600_000 ? '잠시 나감' : `잠시 나감 ${formatClock(student.awayMs)}`);
  return h(
    'li',
    { class: `chip${student.online ? '' : ' off'}` },
    pieceIcon(memberColor(student.color)),
    h('span', { class: 't-ov-name' }, name),
    away,
  );
}

const chipsKey = (students) =>
  students.map((s) => `${s.id}:${s.name}:${s.color}:${s.online}:${s.online ? '' : formatClock(s.awayMs ?? 0)}`).join('|');

function progressText(group) {
  if (group.total === 0) return '퍼즐 없음';
  return `${group.total}조각 중 ${group.placed}조각 (${group.percent}%)`;
}

function setProgress(bar, fill, group) {
  bar.setAttribute('aria-valuenow', String(group.percent));
  bar.setAttribute('aria-valuetext', progressText(group));
  fill.style.setProperty('width', `${group.percent}%`);
}

// One group's card: header (name, progress, %, open), board, students.
function createCard(group, { onOpen }) {
  const titleId = `t-ov-g${group.id}`;
  const fill = h('i');
  const bar = h(
    'div',
    {
      class: 'prog t-ov-prog',
      role: 'progressbar',
      'aria-label': `${group.number}모둠 진행률`,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    },
    fill,
  );
  const pct = h('span', { class: 't-ov-pct', 'aria-hidden': 'true' });
  const open = h(
    'button',
    { class: 't-ov-open', type: 'button', 'aria-label': `${group.number}모둠 크게 보기`, 'aria-describedby': `${titleId}-state` },
    svgIcon(ICON.expand, 18),
  );
  open.addEventListener('click', () => onOpen(group.id));
  const state = h('span', { class: 'sr-only', id: `${titleId}-state` });
  const badge = h('span', { class: 't-ov-badge', hidden: true });
  const empty = h(
    'div',
    { class: 't-ov-empty', hidden: true },
    h('b', {}, '학생이 없어요'),
    h('span', {}, '모둠 편성에서 학생을 넣으면 퍼즐이 시작돼요'),
  );
  const loading = h('span', { class: 't-skel t-ov-skel', 'aria-hidden': 'true' });
  const board = h('div', { class: 't-ov-board' }, loading, empty, badge);
  const mates = h('ul', { class: 't-ov-mates', 'aria-label': `${group.number}모둠 학생` });
  const article = h(
    'article',
    { class: 'card t-ov-card', 'aria-labelledby': titleId, 'data-group': String(group.id) },
    h('div', { class: 't-ov-head' }, h('h2', { id: titleId }, `${group.number}모둠`), bar, pct, open, state),
    board,
    mates,
  );
  return { id: group.id, number: group.number, item: h('li', { class: 't-ov-item' }, article), article, bar, fill, pct, open, state, badge, empty, loading, board, mates, canvas: null, chipsKey: '', boardKey: '' };
}

/**
 * @param {HTMLElement} main
 * @param {object} ctx  teacher app context
 * @param {object} options
 * @param {object} options.session   getSession() row (code, groups, hints, picture keys, piece_count)
 * @param {{ title: string }} options.picture
 * @param {Array} options.builtins  built-in picture list (index.json)
 * @param {(result: { byMe: boolean, doneCount: number, activeCount: number }) => void} options.onEnded
 * @returns {() => void} stop
 */
export function showOverview(main, ctx, { session, picture, builtins, onEnded }) {
  document.documentElement.classList.add('is-overview');
  setTitle(`모둠 한눈에 보기 · 코드 ${session.code}`);
  const hints = hintsFromSession(session);
  let alive = true;
  let raw = null; // last session_overview answer (members patched by local moves)
  let model = null;
  let offset = 0; // server ms - local ms
  let presence = {};
  const seen = new Map();
  const triedKeys = new Set();
  let fails = 0;
  let pollTimer = 0;
  let polling = false;
  let pollAgain = false;
  let art = null;
  let picRevoke = () => {};
  let zoomGroup = null; // group id in the big view
  let zoomCanvas = null;
  let announcedDone = null; // Set of group ids already done (null until the first read)

  // ---------- bar ----------
  const clockText = h('span', { class: 't-ov-clock-text' }, '0:00');
  const clock = h('span', { class: 't-ov-clock', role: 'timer', 'aria-label': '수업 시간' }, svgIcon(ICON.clock, 22), clockText);
  const codeButton = h(
    'button',
    { class: 't-ov-code', type: 'button', 'aria-haspopup': 'dialog' },
    h(
      'span',
      { class: 'pill pri' },
      h('span', { class: 'sr-only' }, '수업 '),
      `코드 ${formatCode(session.code)}`,
      h('span', { class: 'sr-only' }, ', 코드와 QR 크게 보기'),
    ),
  );
  const groupingButton = h('button', { class: 'btn t-bar-btn', type: 'button', 'aria-haspopup': 'dialog' }, svgIcon(ICON.people, 20), '모둠 편성');
  const endButton = h('button', { class: 'btn danger t-bar-btn', type: 'button', 'aria-haspopup': 'dialog' }, '수업 끝내기');
  ctx.setBar('lobby', {
    nodes: [
      h('span', { class: 'pill t-summary' }, `${picture.title} · ${session.piece_count}조각`),
      codeButton,
      h('span', { class: 'spacer' }),
      clock,
      groupingButton,
      endButton,
    ],
  });

  // ---------- page ----------
  const doneCount = h('b', {}, '0');
  const doneTotal = h('span', {}, `/ ${session.groups.length}모둠`);
  const average = h('b', {}, '0%');
  const lateNames = h('span', { class: 't-ov-late-names' });
  const lateCount = h('b', {});
  const lateButton = h('button', { class: 'btn pri t-ov-late-btn', type: 'button' }, '모둠에 넣기');
  const late = h(
    'div',
    { class: 't-ov-late', hidden: true },
    h('p', {}, '모둠이 없는 학생 ', lateCount, h('span', { class: 't-ov-late-sep', 'aria-hidden': 'true' }, ' · '), lateNames),
    lateButton,
  );
  const lateLive = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const warning = h('p', { class: 't-error t-ov-warn', role: 'alert' });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const cards = session.groups.map((g) => createCard(g, { onOpen: openZoom }));
  const columns = overviewColumns(cards.length);
  const grid = h(
    'ul',
    {
      class: 't-ov-grid',
      'aria-label': '모둠',
      style: { '--ov-cols': columns, '--ov-rows': Math.ceil(cards.length / columns) },
    },
    cards.map((c) => c.item),
  );
  const view = h(
    'section',
    { class: 't-ov', 'aria-labelledby': 't-ov-title' },
    h('h1', { class: 'sr-only', id: 't-ov-title', tabindex: '-1' }, `${picture.title} 모둠 한눈에 보기`),
    h(
      'div',
      { class: 't-ov-sum' },
      h('span', { class: 'pill ok t-ov-done' }, '완성 ', doneCount, ' ', doneTotal),
      h('span', { class: 'pill t-ov-avg' }, '평균 진행률 ', average),
      h('span', { class: 'pill t-ov-hints' }, hintsSummary(hints)),
      h('span', { class: 't-ov-note' }, '모둠을 누르면 크게 볼 수 있어요 · 3초마다 새로 고침'),
    ),
    late,
    lateLive,
    warning,
    grid,
    announcer,
  );

  // ---------- dialogs ----------
  const zoom = createZoomDialog();
  const grouping = createGroupingDialog();
  const code = createCodeDialog(session);
  let endedByMe = false;
  let ending = false;
  const end = actionDialog({
    id: 't-end',
    title: '수업을 끝낼까요?',
    text: '학생 화면에 ‘수업이 끝났어요’가 나오고 이 코드로 더 이상 들어올 수 없어요. 모둠 배정과 학생 익명 계정은 바로 지워져요.',
    confirm: '수업 끝내기',
    busy: '끝내는 중…',
    failed: '수업을 끝내지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.',
    action: async () => {
      // The 'end' broadcast (or a read) can arrive before the answer: this dialog finishes.
      ending = true;
      try {
        await endSession(ctx.client, session.id);
      } finally {
        ending = false;
      }
      endedByMe = true;
    },
  });
  end.addEventListener('close', () => {
    if (endedByMe) finish(true);
  });
  main.replaceChildren(view, zoom.dialog, grouping.dialog, code, end);

  codeButton.addEventListener('click', () => code.showModal());
  groupingButton.addEventListener('click', () => grouping.open());
  lateButton.addEventListener('click', () => grouping.open());
  endButton.addEventListener('click', () => end.showModal());

  // ---------- reading ----------
  function names() {
    const rows = raw?.members ?? [];
    const { names: online, unknownKeys } = presenceNames(presence, rows);
    for (const [id, name] of online) seen.set(id, name);
    // A Presence key with no row yet: most likely a student who just joined.
    if (unknownKeys.some((key) => !triedKeys.has(key))) {
      unknownKeys.forEach((key) => triedKeys.add(key));
      poll();
    }
    return online;
  }

  function rebuild() {
    if (!raw || !alive) return;
    model = buildOverview(raw, { online: names(), seen, serverNow: Date.now() + offset });
    render();
  }

  async function poll() {
    if (!alive) return;
    clearTimeout(pollTimer);
    pollTimer = 0;
    if (document.visibilityState === 'hidden') return;
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    try {
      const sentAt = Date.now();
      const answer = await fetchOverview(ctx.client, session.id);
      if (!alive) return;
      offset = clockOffset(answer.now, sentAt, Date.now());
      raw = answer;
      fails = 0;
      warning.textContent = '';
      if (answer.status === 'ended') {
        if (!ending && !endedByMe) finish(false);
        return;
      }
      rebuild();
    } catch (error) {
      console.error(error);
      fails += 1;
      if (fails >= FAILS_BEFORE_WARNING) warning.textContent = '새 정보를 받지 못하고 있어요. 인터넷 연결을 확인해 주세요.';
    } finally {
      polling = false;
      if (alive) {
        if (pollAgain) {
          pollAgain = false;
          poll();
        } else if (document.visibilityState !== 'hidden') {
          pollTimer = setTimeout(poll, POLL_MS);
        }
      }
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      clearTimeout(pollTimer);
      pollTimer = 0;
    } else {
      poll();
      tick();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  // ---------- clock ----------
  function tick() {
    if (!model?.startedAt) return;
    const elapsed = Date.now() + offset - model.startedAt;
    const text = formatClock(elapsed);
    if (clockText.textContent !== text) {
      clockText.textContent = text;
      clock.setAttribute('aria-label', `수업 시간 ${spokenClock(elapsed)}`);
    }
  }
  const clockTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') tick();
  }, 1000);

  // ---------- drawing ----------
  function boardStateOf(group) {
    const colors = new Map();
    for (const s of group.students) {
      const row = model.members.find((m) => m.id === s.id);
      if (row) colors.set(row.user_id, memberColor(s.color));
    }
    return { clusters: group.clusters, done: group.done, colors };
  }

  const boardKey = (group, state) =>
    `${group.done}|${JSON.stringify(group.clusters)}|${[...state.colors].join(',')}`;

  function renderCard(card, group) {
    const empty = group.total === 0;
    card.article.classList.toggle('is-done', group.done);
    card.article.classList.toggle('is-empty', empty);
    setProgress(card.bar, card.fill, group);
    card.bar.hidden = empty;
    card.pct.textContent = empty ? '' : group.done ? '완성' : `${group.percent}%`;
    card.state.textContent = group.done
      ? `완성, 걸린 시간 ${formatDuration(group.durationMs ?? 0)}`
      : empty
        ? '학생이 없어요'
        : `${progressText(group)} 맞췄어요`;
    card.open.disabled = empty;
    card.empty.hidden = !empty;
    card.badge.hidden = !group.done;
    card.badge.textContent = group.durationMs === null ? '완성' : `완성 · ${formatDuration(group.durationMs)}`;
    const key = chipsKey(group.students);
    if (key !== card.chipsKey) {
      card.chipsKey = key;
      card.mates.replaceChildren(...group.students.map(studentChip));
    }
    if (card.canvas && !empty) {
      const state = boardStateOf(group);
      const next = boardKey(group, state);
      if (next !== card.boardKey) {
        card.boardKey = next;
        card.canvas.setState(state);
      }
    }
  }

  function render() {
    if (!model) return;
    tick();
    doneCount.textContent = String(model.doneCount);
    doneTotal.textContent = `/ ${model.activeCount || session.groups.length}모둠`;
    average.textContent = `${model.averagePercent}%`;
    for (const card of cards) {
      const group = model.groups.find((g) => g.id === card.id);
      if (group) renderCard(card, group);
    }
    renderLate();
    // Progress bars slide from the next refresh on, not from 0 on the first drawing.
    if (!view.classList.contains('is-live')) requestAnimationFrame(() => view.classList.add('is-live'));
    zoom.render();
    grouping.update();
    announceCompletions();
  }

  function renderLate() {
    const pool = model.pool;
    late.hidden = pool.length === 0;
    lateCount.textContent = `${pool.length}명`;
    const list = pool.map((s) => s.name ?? UNKNOWN_NAME).join(', ');
    lateNames.textContent = list;
    const text = pool.length ? `모둠이 없는 학생 ${pool.length}명: ${list}` : '';
    if (lateLive.dataset.text !== text) {
      lateLive.dataset.text = text;
      lateLive.textContent = text;
    }
  }

  function announceCompletions() {
    const done = new Set(model.groups.filter((g) => g.done).map((g) => g.id));
    if (announcedDone) {
      const fresh = model.groups.filter((g) => g.done && !announcedDone.has(g.id));
      if (fresh.length) {
        announcer.textContent = '';
        const text = `${fresh.map((g) => `${g.number}모둠`).join(', ')} 완성했어요!`;
        requestAnimationFrame(() => (announcer.textContent = text));
        for (const g of fresh) cards.find((c) => c.id === g.id)?.article.classList.add('is-new-done');
      }
    }
    announcedDone = done;
  }

  // ---------- boards ----------
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === zoom.boardHost) zoomCanvas?.resize();
      else cards.find((c) => c.board === entry.target)?.canvas?.resize();
    }
  });

  async function loadBoards() {
    try {
      const [setup, source] = await Promise.all([getPuzzleSetup(ctx.client, session.id), pictureSource(ctx.client, session, builtins)]);
      picRevoke = source.revoke;
      const image = await loadPicture(source.src);
      if (!alive) return;
      const layout = layoutFor(setup.cols, setup.rows, setup.aspect);
      art = createBoardArt({ layout, seed: setup.seed, picture: image, hints });
      grid.style.setProperty('--board-ratio', String(layout.boardWidth / layout.boardHeight));
      zoom.boardHost.style.setProperty('--board-ratio', String(layout.boardWidth / layout.boardHeight));
      for (const card of cards) {
        card.loading.remove();
        card.canvas = createBoardCanvas(card.board, art, 'mini');
        resizeObserver.observe(card.board);
        card.canvas.resize();
        card.boardKey = '';
      }
      zoom.attach();
      render();
    } catch (error) {
      console.error(error);
      for (const card of cards) {
        card.loading.remove();
        card.board.classList.add('is-failed');
      }
      warning.textContent = '모둠 판 그림을 불러오지 못했어요. 새로고침해 주세요. 진행률은 계속 새로 고쳐요.';
    }
  }

  // ---------- big view of one group ----------
  function openZoom(groupId) {
    zoomGroup = groupId;
    zoom.show();
  }

  function createZoomDialog() {
    const title = h('h2', { id: 't-ov-zoom-title' });
    const fill = h('i');
    const bar = h('div', { class: 'prog t-ov-prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
    const pct = h('span', { class: 't-ov-pct', 'aria-hidden': 'true' });
    const prev = h('button', { class: 'iconbtn', type: 'button', 'aria-label': '이전 모둠' }, svgIcon(ICON.prev, 22));
    const next = h('button', { class: 'iconbtn', type: 'button', 'aria-label': '다음 모둠' }, svgIcon(ICON.next, 22));
    const close = h('button', { class: 'iconbtn', type: 'button', 'aria-label': '닫기' }, svgIcon(ICON.close, 22));
    const badge = h('span', { class: 't-ov-badge', hidden: true });
    const boardHost = h('div', { class: 't-ov-board t-ov-zboard' }, badge);
    const status = h('p', { class: 't-ov-zstatus' });
    const mates = h('ul', { class: 't-ov-mates', 'aria-label': '모둠 학생' });
    const dialog = h(
      'dialog',
      { class: 't-ov-zoom', 'aria-labelledby': 't-ov-zoom-title', 'aria-describedby': 't-ov-zoom-status' },
      h('div', { class: 't-ov-zhead' }, title, bar, pct, h('div', { class: 't-ov-znav' }, prev, next, close)),
      boardHost,
      h('div', { class: 't-ov-zfoot' }, mates, status),
    );
    status.id = 't-ov-zoom-status';
    let shownGroup = null;
    let chips = '';
    let key = '';

    const playable = () => (model?.groups ?? []).filter((g) => g.total > 0);
    function go(step) {
      const list = playable();
      if (list.length < 2) return;
      const at = list.findIndex((g) => g.id === zoomGroup);
      zoomGroup = list[(at + step + list.length) % list.length].id;
      render();
    }
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
      else return;
      event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      const card = cards.find((c) => c.id === zoomGroup);
      zoomGroup = null;
      zoomCanvas?.destroy();
      zoomCanvas = null;
      shownGroup = null;
      card?.open.focus();
    });

    function attach() {
      if (zoomGroup !== null) render();
    }

    function render() {
      if (!dialog.open || zoomGroup === null || !model) return;
      const group = model.groups.find((g) => g.id === zoomGroup);
      if (!group) return;
      title.textContent = `${group.number}모둠`;
      bar.setAttribute('aria-label', `${group.number}모둠 진행률`);
      setProgress(bar, fill, group);
      pct.textContent = group.done ? '완성' : `${group.percent}%`;
      dialog.classList.toggle('is-done', group.done);
      badge.hidden = !group.done;
      badge.textContent = group.durationMs === null ? '완성' : `완성 · ${formatDuration(group.durationMs)}`;
      status.textContent = group.done
        ? `모든 조각을 맞췄어요. 걸린 시간 ${formatDuration(group.durationMs ?? 0)}`
        : `${group.total}조각 중 ${group.placed}조각을 맞췄어요`;
      const multiple = playable().length > 1;
      prev.disabled = !multiple;
      next.disabled = !multiple;
      const nextChips = chipsKey(group.students);
      if (shownGroup !== group.id || nextChips !== chips) {
        chips = nextChips;
        mates.replaceChildren(...group.students.map(studentChip));
      }
      if (!art) return;
      if (shownGroup !== group.id || !zoomCanvas) {
        zoomCanvas?.destroy();
        zoomCanvas = createBoardCanvas(boardHost, art, 'zoom');
        zoomCanvas.resize();
        key = '';
      }
      shownGroup = group.id;
      const state = boardStateOf(group);
      const nextKey = boardKey(group, state);
      if (nextKey !== key) {
        key = nextKey;
        zoomCanvas.setState(state);
      }
    }

    return {
      dialog,
      boardHost,
      attach,
      render,
      show() {
        dialog.showModal();
        resizeObserver.observe(boardHost);
        render();
      },
    };
  }

  // ---------- 모둠 편성 (late students, moves) ----------
  function createGroupingDialog() {
    const panel = createGroupingPanel({ groups: session.groups, onAssign: assign, onRandomize: () => {}, onStart: () => {} });
    const close = h('button', { class: 'iconbtn t-ov-gclose', type: 'button', 'aria-label': '모둠 편성 닫기' }, svgIcon(ICON.close, 22));
    const done = h('button', { class: 'btn pri', type: 'button' }, '다 했어요');
    const dialog = h(
      'dialog',
      { class: 't-ov-groups', 'aria-labelledby': 't-grouping-title' },
      close,
      panel.element,
      h('div', { class: 't-ov-gfoot' }, done),
    );
    close.addEventListener('click', () => dialog.close());
    done.addEventListener('click', () => dialog.close());
    // Escape first drops a picked student or a drag (the panel handles those), then closes.
    let keepOpen = false;
    dialog.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') keepOpen = panel.element.classList.contains('has-pick') || panel.isDragging();
      },
      true,
    );
    dialog.addEventListener('cancel', (event) => {
      if (keepOpen) event.preventDefault();
      keepOpen = false;
    });

    async function assign(memberId, groupId) {
      const row = raw?.members.find((m) => Number(m.id) === memberId);
      if (!row) return;
      const before = { group_id: row.group_id, color: row.color };
      panel.clearError();
      Object.assign(row, { group_id: groupId, color: groupId === null ? null : row.color });
      rebuild();
      try {
        const saved = await assignMember(ctx.client, memberId, groupId);
        Object.assign(row, { group_id: saved.group_id, color: saved.color });
      } catch (error) {
        console.error(error);
        Object.assign(row, before);
        panel.showError(
          error?.message === 'session_ended' ? '이미 끝난 수업이에요.' : '옮기지 못했어요. 인터넷 연결을 확인하고 다시 해 주세요.',
        );
      }
      rebuild();
      poll();
    }

    return {
      dialog,
      open() {
        update();
        dialog.showModal();
      },
      update,
      destroy: () => panel.destroy(),
    };

    function update() {
      if (model) panel.update(model.roster, { status: 'playing' });
    }
  }

  // ---------- presence ----------
  // The lobby has just left the same topic; supabase-js hands back a channel that is still
  // leaving, so wait until it is gone before joining again.
  let channel = null;
  topicFree(ctx.client, `session:${session.id}`)
    .then(() => ctx.client.realtime.setAuth())
    .catch((error) => console.error(error))
    .then(() => {
      if (!alive) return;
      channel = ctx.client.channel(`session:${session.id}`, { config: { private: true } });
      channel
        .on('presence', { event: 'sync' }, () => {
          presence = channel.presenceState();
          rebuild();
        })
        .on('broadcast', { event: 'groups' }, () => poll())
        .on('broadcast', { event: 'end' }, () => {
          if (!ending && !endedByMe) finish(false);
        })
        .subscribe();
    });

  // ---------- life cycle ----------
  function stop() {
    if (!alive) return;
    alive = false;
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    resizeObserver.disconnect();
    for (const card of cards) card.canvas?.destroy();
    zoomCanvas?.destroy();
    art?.dispose();
    picRevoke();
    grouping.destroy();
    document.documentElement.classList.remove('is-overview');
    if (channel) ctx.client.removeChannel(channel).catch(() => {});
  }

  function finish(byMe) {
    if (!alive) return;
    const result = { byMe, doneCount: model?.doneCount ?? 0, activeCount: model?.activeCount ?? 0 };
    for (const d of [zoom.dialog, grouping.dialog, code]) if (d.open) d.close();
    stop();
    onEnded(result);
  }

  poll();
  loadBoards();
  // Test hook: the last model (read only).
  window.__overview = { model: () => model, poll };
  return () => {
    stop();
    delete window.__overview;
  };
}

// Resolves once no channel of the client is on `topic` (at most `waitMs`, then it is removed).
async function topicFree(client, topic, waitMs = 3000) {
  const full = `realtime:${topic}`;
  const deadline = Date.now() + waitMs;
  while (client.getChannels().some((c) => c.topic === full) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const stale of client.getChannels().filter((c) => c.topic === full)) await client.removeChannel(stale);
}

// Code, address and QR again, big, for students who come late.
function createCodeDialog(session) {
  const url = joinUrl(location.origin, session.code);
  const close = h('button', { class: 'btn', type: 'button', autofocus: true }, '닫기');
  const dialog = h(
    'dialog',
    { class: 't-ov-codebox', 'aria-labelledby': 't-ov-code-title' },
    h('h2', { id: 't-ov-code-title' }, '늦게 온 학생은 이 코드로 들어와요'),
    h('p', { class: 't-join-url' }, location.host),
    h('p', { class: 't-join-code' }, h('span', { class: 'sr-only' }, '수업 코드 '), formatCode(session.code)),
    h('div', { class: 't-join-qr', html: qrSvg(url, `입장 QR 코드: ${url}`) }),
    h('p', { class: 't-join-note' }, 'QR 코드를 찍으면 코드를 넣지 않아도 돼요. 들어온 학생은 모둠 편성에서 모둠에 넣어 주세요.'),
    h('div', { class: 't-actions' }, close),
  );
  close.addEventListener('click', () => dialog.close());
  return dialog;
}

