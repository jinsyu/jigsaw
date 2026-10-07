// Student puzzle screen (mockups student-phone #4, student-tablet). Reads and
// changes puzzle data only through a PuzzleStore, so the in-memory demo store
// and the Supabase store (T11) plug in the same way.
import { makePuzzle } from '../puzzle/geometry.js';
import { resolveDrop } from '../puzzle/snap.js';
import { cellOfPiece, isPuzzleStore, pieceOfCell } from '../store/puzzle-store.js';
import { createBoardView } from './board-view.js';
import { freeSpot } from './placement.js';
import { loadPicture } from './picture.js';
import { drawPiece, pieceBox, createSpriteCache } from './sprites.js';
import { createTrayView } from './tray-view.js';

export const MEMBER_COLORS = ['#F0544F', '#22A559', '#3B82F6', '#9B51E0', '#F2A20C', '#E64C9A'];
const MAX_DPR = 2;
const SNAP_VIBRATE_MS = 30;
const TOAST_MS = 2600;

// Same piece outline as the mockup icon (iconPiece): centre piece of a 3 x 3 puzzle, seed 5.
const ICON_PATH = makePuzzle({ cols: 3, rows: 3, width: 300, height: 300 }, 5).at(1, 1).d;
const PICTURE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.6"/></svg>';

const coarsePointer = () => window.matchMedia?.('(any-pointer: coarse)').matches ?? false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pieceIcon(color) {
  const span = el('span', 'ic');
  span.innerHTML = `<svg viewBox="70 70 160 160" aria-hidden="true"><path d="${ICON_PATH}" fill="${color}"/></svg>`;
  return span;
}

function buildLayout(main) {
  main.className = 'play';
  main.replaceChildren();
  main.setAttribute('aria-busy', 'true');

  const top = el('header', 'pz-top');
  const title = el('h1', 'pz-title');
  const progress = el('div', 'pz-progress');
  const bar = el('span', 'prog pz-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', '맞춘 조각');
  bar.setAttribute('aria-valuemin', '0');
  const fill = el('i');
  bar.append(fill);
  const count = el('span', 'pz-count');
  progress.append(bar, count);
  const chips = el('ul', 'pz-chips');
  chips.setAttribute('aria-label', '모둠 친구');
  const pictureBtn = el('button', 'iconbtn pz-picture-btn');
  pictureBtn.type = 'button';
  pictureBtn.innerHTML = `${PICTURE_ICON}<span class="pz-btn-label">완성 그림</span>`;
  pictureBtn.setAttribute('aria-label', '완성 그림 보기');
  pictureBtn.setAttribute('aria-haspopup', 'dialog');
  top.append(title, progress, chips, pictureBtn);

  const body = el('div', 'pz-body');
  const board = el('section', 'pz-board');
  board.setAttribute('aria-label', '퍼즐 판');
  const hint = el('p', 'pz-hint', coarsePointer() ? '두 손가락으로 크게 볼 수 있어요' : '마우스 휠로 크게 볼 수 있어요');
  const toast = el('p', 'pz-toast');
  toast.setAttribute('role', 'status');
  board.append(hint, toast);

  const tray = el('section', 'pz-tray');
  tray.setAttribute('aria-labelledby', 'pz-tray-title');
  const trayHead = el('div', 'pz-tray-h');
  const trayTitle = el('h2', 'pz-tray-title');
  trayTitle.id = 'pz-tray-title';
  const trayNote = el('p', 'pz-tray-note');
  trayHead.append(trayTitle, trayNote);
  const tiles = el('div', 'pz-tiles');
  tray.append(trayHead, tiles);
  body.append(board, tray);

  const dialog = el('dialog', 'pz-dialog');
  dialog.setAttribute('aria-labelledby', 'pz-dialog-title');
  const dialogTitle = el('h2', null, '완성 그림');
  dialogTitle.id = 'pz-dialog-title';
  const dialogImg = el('img');
  dialogImg.alt = '완성 그림';
  const close = el('button', 'btn', '닫기');
  close.type = 'button';
  dialog.append(dialogTitle, dialogImg, close);

  const status = el('p', 'pz-loading', '퍼즐을 준비하고 있어요');
  status.setAttribute('role', 'status');
  board.append(status);

  main.append(top, body, dialog);
  return { main, title, bar, fill, count, chips, pictureBtn, board, hint, toast, tray, trayTitle, trayNote, tiles, dialog, dialogImg, close, status };
}

function renderMembers(ui, state) {
  const items = state.members.map((m) => {
    const li = el('li', `chip${m.online ? '' : ' off'}`);
    li.append(pieceIcon(MEMBER_COLORS[m.color % MEMBER_COLORS.length]), document.createTextNode(m.name));
    if (m.uid === state.me && m.name !== '나') li.append(el('em', null, '나'));
    else if (!m.online) li.append(el('em', null, '잠시 나감'));
    return li;
  });
  ui.chips.replaceChildren(...items);
}

function setupDialog(ui) {
  const canModal = typeof ui.dialog.showModal === 'function';
  ui.pictureBtn.addEventListener('click', () => {
    if (canModal) ui.dialog.showModal();
    else ui.dialog.setAttribute('open', '');
  });
  ui.close.addEventListener('click', () => {
    if (canModal) ui.dialog.close();
    else ui.dialog.removeAttribute('open');
  });
  // Tap outside the picture closes it.
  ui.dialog.addEventListener('click', (e) => {
    if (e.target === ui.dialog && canModal) ui.dialog.close();
  });
}

/**
 * Mounts the puzzle screen into `main` and resolves with a small handle once ready.
 * @param {HTMLElement} main
 * @param {import('../store/puzzle-store.js').PuzzleStore} store
 */
export async function mountPlayScreen(main, store) {
  if (!isPuzzleStore(store)) throw new TypeError('mountPlayScreen needs a PuzzleStore');
  document.documentElement.classList.add('is-play');
  const ui = buildLayout(main);
  let state = store.getState();
  const { layout } = state;
  ui.title.textContent = state.groupName;
  ui.bar.setAttribute('aria-valuemax', String(state.progress.total));
  ui.dialogImg.src = state.picture.src;
  ui.dialogImg.width = state.picture.width;
  ui.dialogImg.height = state.picture.height;
  setupDialog(ui);

  let picture;
  try {
    picture = await loadPicture(state.picture.src);
  } catch (error) {
    ui.status.textContent = '그림을 불러오지 못했어요. 새로고침해 주세요.';
    main.removeAttribute('aria-busy');
    throw error;
  }
  const puzzle = makePuzzle(layout, state.seed);
  const sprites = createSpriteCache({ puzzle, layout, picture });
  const dpr = () => Math.min(MAX_DPR, window.devicePixelRatio || 1);

  let toastTimer = 0;
  function showToast(text, { sticky = false, tone = '' } = {}) {
    clearTimeout(toastTimer);
    ui.toast.textContent = text;
    ui.toast.className = `pz-toast is-shown${tone ? ` ${tone}` : ''}`;
    if (!sticky) toastTimer = setTimeout(() => ui.toast.classList.remove('is-shown'), TOAST_MS);
  }

  function snapFeedback() {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(SNAP_VIBRATE_MS);
  }

  // A remote store may answer grab() after the finger is already lifted, so a
  // board drop waits for its grab before calling drop().
  let pendingGrab = Promise.resolve({ ok: true });

  // Show the JS snap result right away; the store result confirms it.
  async function dropCluster(clusterId, x, y, grab = Promise.resolve({ ok: true })) {
    const current = store.getState();
    if (current.clusters.some((c) => c.id === clusterId)) {
      const plain = current.clusters.map(({ id, x: cx, y: cy, pieces }) => ({ id, x: cx, y: cy, pieces }));
      const predicted = resolveDrop(layout, plain, { id: clusterId, x, y });
      const merged = predicted.clusters.find((c) => c.id === predicted.id);
      const snapped = predicted.absorbed.length > 0;
      board.settle(merged.pieces.map((cell) => pieceOfCell(cell, layout.cols)), predicted.x, predicted.y, { snapped });
      if (snapped) snapFeedback();
    }
    const grabbed = await grab;
    if (!grabbed.ok) {
      board.setClusters(store.getState().clusters);
      return grabbed;
    }
    const result = await store.drop(clusterId, x, y);
    if (!result.ok) board.setClusters(store.getState().clusters);
    return result;
  }

  // Store calls run after the gesture ended; failures are shown, logged and resynced.
  function settleAction(promise) {
    promise.catch((error) => {
      console.error(error);
      showToast('잠시 문제가 생겼어요. 다시 해 볼까요?');
      board.setClusters(store.getState().clusters);
    });
  }

  async function placeFromTray(index, x, y) {
    board.expectFromTray(index, x, y);
    const taken = await store.takeFromTray(index, x, y);
    if (!taken.ok) {
      showToast('이 조각은 지금 꺼낼 수 없어요.');
      return;
    }
    await dropCluster(taken.clusterId, x, y);
  }

  const board = createBoardView(ui.board, {
    layout,
    puzzle,
    sprites,
    async onGrab(clusterId) {
      pendingGrab = store.grab(clusterId);
      const result = await pendingGrab;
      if (!result.ok && result.reason === 'held') showToast('친구가 잡고 있는 조각이에요.');
      return result.ok;
    },
    onDrop: (clusterId, x, y) => settleAction(dropCluster(clusterId, x, y, pendingGrab)),
    onZoom() {
      ui.hint.classList.add('is-hidden');
    },
  });
  board.canvas.setAttribute('role', 'img');
  board.canvas.setAttribute('aria-label', '퍼즐 판: 한 손가락으로 조각을 옮기고, 두 손가락으로 크게 봐요');

  function makeGhost(index) {
    const piece = puzzle.pieces[index];
    const box = pieceBox(layout, piece);
    const scale = board.camera.scale;
    const width = box.w * scale;
    const height = box.h * scale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * dpr());
    canvas.height = Math.ceil(height * dpr());
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    drawPiece(canvas.getContext('2d'), { piece, path: sprites.paths[index], picture, layout, scale: scale * dpr() });
    const outer = el('div');
    outer.append(canvas);
    // The finger holds the centre of the piece cell.
    const anchorX = (piece.x0 + layout.pw / 2 - box.x) * scale;
    const anchorY = (piece.y0 + layout.ph / 2 - box.y) * scale;
    canvas.style.transformOrigin = `${anchorX}px ${anchorY}px`;
    return { el: outer, inner: canvas, width, height, anchorX, anchorY };
  }

  function renderTile(index, canvas, cssSize) {
    const piece = puzzle.pieces[index];
    const box = pieceBox(layout, piece);
    const size = Math.round(cssSize * dpr());
    canvas.width = size;
    canvas.height = size;
    const scale = size / Math.max(box.w, box.h);
    const ctx = canvas.getContext('2d');
    ctx.translate((size - box.w * scale) / 2, (size - box.h * scale) / 2);
    drawPiece(ctx, { piece, path: sprites.paths[index], picture, layout, scale });
  }

  const tray = createTrayView(ui.tiles, {
    renderTile,
    makeGhost,
    ghostHost: main,
    canDropAt: (cx, cy) => board.containsClient(cx, cy),
    onDropAt(index, cx, cy) {
      const b = board.clientToBoard(cx, cy);
      const piece = puzzle.pieces[index];
      settleAction(placeFromTray(index, b.x - (piece.x0 + layout.pw / 2), b.y - (piece.y0 + layout.ph / 2)));
    },
    onTap(index) {
      const spot = freeSpot(layout, board.visibleRect(), store.getState().clusters, cellOfPiece(index, layout.cols));
      settleAction(placeFromTray(index, spot.x, spot.y));
    },
  });

  let wasComplete = state.progress.complete;
  function render(next) {
    state = next;
    const { placed, total, complete } = state.progress;
    ui.fill.style.width = `${(100 * placed) / total}%`;
    ui.bar.setAttribute('aria-valuenow', String(placed));
    ui.count.textContent = `${placed} / ${total}`;
    ui.trayTitle.textContent = `내 조각 ${state.tray.length}개`;
    if (state.tray.length > 0) {
      ui.trayNote.innerHTML = '<span>끌어서 판에 놓아요</span><span class="pz-sep"> · </span><span>나만 꺼낼 수 있어요</span>';
    } else {
      ui.trayNote.textContent = '상자가 비었어요. 판 위 조각을 함께 맞춰요';
    }
    ui.tray.classList.toggle('is-empty', state.tray.length === 0);
    tray.setPieces(state.tray);
    board.setClusters(state.clusters);
    if (complete && !wasComplete) showToast('모든 조각이 맞았어요!', { sticky: true, tone: 'ok' });
    wasComplete = complete;
  }

  renderMembers(ui, state);
  render(state);
  const unsubscribe = store.subscribe((next) => render(next));
  ui.status.remove();
  main.removeAttribute('aria-busy');
  main.dataset.ready = 'true';

  return {
    board,
    destroy() {
      unsubscribe();
      board.destroy();
      document.documentElement.classList.remove('is-play');
    },
  };
}
