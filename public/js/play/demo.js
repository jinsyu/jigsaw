// /play?demo=1 — solo puzzle on a built-in picture, kept in memory.
// &picture=<key> picks the built-in picture (public/images/builtin/index.json, default: the
// first one there);
// &pieces=12|24|48|70|96 picks the piece count (default 24); help settings (spec rule 10):
// &preview=1 &outline=0 &button=0 &underlay=1 (1 = on, 0 = off, missing = default;
// button = the completed picture button).
// For development and demonstrations only: no server, nothing is saved.
import { PIECE_COUNTS, gridFor, layoutFor } from '../puzzle/geometry.js';
import { createLocalStore, shuffledPieces } from '../store/local-store.js';
import { mountPlayScreen } from './play-screen.js';
import { formatDuration } from '../student/celebrate.js';
import { exposeTestHook } from '../test-hooks.js';

const BUILTIN_INDEX = '/images/builtin/index.json';
const DEFAULT_PIECES = 24;
const SEED = 42;
const ME = 'demo';

// Piece count from the page address; anything but a supported count gives the default.
export function demoPieceCount(search) {
  const n = Number(new URLSearchParams(search).get('pieces'));
  return PIECE_COUNTS.includes(n) ? n : DEFAULT_PIECES;
}

const HINT_PARAMS = { preview: 'preview', outline: 'outline', button: 'pictureButton', underlay: 'underlay' };

// Help settings from the page address; only '1' and '0' count.
export function demoHints(search) {
  const params = new URLSearchParams(search);
  const hints = {};
  for (const [param, key] of Object.entries(HINT_PARAMS)) {
    const value = params.get(param);
    if (value === '1' || value === '0') hints[key] = value === '1';
  }
  return hints;
}

// Built-in picture key from the page address (null: none or malformed, the default is used).
export function demoPictureKey(search) {
  const value = new URLSearchParams(search).get('picture');
  return value && /^[a-z0-9-]{1,64}$/.test(value) ? value : null;
}

// { src, width, height, credit } of a built-in picture; a missing or unknown key gives the
// first picture of the index.
export async function loadDemoPicture(key, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(BUILTIN_INDEX);
  if (!response.ok) throw new Error(`built-in pictures: ${response.status}`);
  const { images } = await response.json();
  const found = images.find((image) => image.key === key) ?? images[0];
  if (!found) throw new Error('no built-in pictures');
  return { src: found.src, width: found.width, height: found.height, ...(found.credit ? { credit: found.credit } : {}) };
}

export function createDemoStore(pieceCount = DEFAULT_PIECES, hints = {}, picture) {
  const aspect = picture.width / picture.height;
  const { cols, rows } = gridFor(pieceCount, aspect);
  return createLocalStore({
    layout: layoutFor(cols, rows, aspect),
    seed: SEED,
    picture,
    groupName: '혼자 연습',
    me: ME,
    members: [{ uid: ME, name: '나', color: 0 }],
    trays: { [ME]: shuffledPieces(pieceCount, SEED) },
    hints,
  });
}

// '다른 그림 고르기' goes back to the practice pictures on the home page.
const PRACTICE_HOME = '/#practice';

// Done: a card over the board with the time taken, another try or another picture.
export function renderDemoDone(board, { durationMs }) {
  const card = document.createElement('div');
  card.className = 'pz-done';
  card.setAttribute('role', 'status');
  const title = document.createElement('h2');
  title.className = 'pz-done-title';
  title.tabIndex = -1;
  title.textContent = '모든 조각이 맞았어요!';
  const time = document.createElement('p');
  time.className = 'pz-done-time';
  time.textContent = `걸린 시간 ${formatDuration(durationMs)}`;
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'btn';
  again.textContent = '한 번 더 하기';
  again.addEventListener('click', () => location.reload());
  const other = document.createElement('a');
  other.className = 'btn pri';
  other.href = PRACTICE_HOME;
  other.textContent = '다른 그림 고르기';
  const actions = document.createElement('div');
  actions.className = 'pz-done-actions';
  actions.append(again, other);
  card.append(title, time, actions);
  board.append(card);
  // Screen readers and keyboards land on the card (a status added with its text is not always read).
  title.focus({ preventScroll: true });
  return card;
}

export async function startDemo(main) {
  const picture = await loadDemoPicture(demoPictureKey(location.search));
  const store = createDemoStore(demoPieceCount(location.search), demoHints(location.search), picture);
  const screen = await mountPlayScreen(main, store, {
    onComplete: (state) => renderDemoDone(main.querySelector('.pz-board'), { durationMs: (state.completedAt ?? Date.now()) - state.startedAt }),
  });
  // Back to the home page (the practice pictures), before the title.
  const back = document.createElement('a');
  back.className = 'iconbtn pz-back';
  back.href = PRACTICE_HOME;
  back.setAttribute('aria-label', '처음 화면으로');
  back.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  main.querySelector('.pz-title')?.before(back);
  // Alone: no group members to show.
  main.querySelector('.pz-chips')?.setAttribute('hidden', '');
  // Test hook (local stack only, test-hooks.js): read-only view of the state and the camera.
  exposeTestHook('__puzzleDemo', {
    state: () => store.getState(),
    camera: () => screen.board.camera,
    preview: () => screen.board.preview,
    animating: () => screen.board.animating,
    boardToClient: (x, y) => screen.board.boardToClient(x, y),
  });
}
