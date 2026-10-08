// A student's group puzzle in class: the picture (built-in file, or the teacher's picture through
// the signed URL the rt server sent with the state), the class store for the group
// (remote-store.js on the class socket, student/live.js) and the puzzle screen:
// - board states and events from the socket go to the store (kept while the picture loads);
// - the page hidden: let go of everything held (spec rule 6); back: ask for a fresh state;
// - every piece in the frame: the completion screen.
// The rt server decides everything (holds, the one-minute rule, completion); nothing runs on
// a timer here.
import { layoutFor } from '../puzzle/geometry.js';
import { mountPlayScreen } from '../play/play-screen.js';
import { createRemoteStore } from '../store/remote-store.js';
import { h } from '../teacher/dom.js';
import { exposeTestHook } from '../test-hooks.js';
import { renderCelebration } from './celebrate.js';

const BUILTIN_INDEX = '/images/builtin/index.json';

// Members for the store from the class mates. A friend whose name this screen has not got
// (after a server restart, until their device is back) keeps the name seen before (`seen`:
// id -> name, updated here); never seen: '친구'.
export function membersFromMates(mates, seen = new Map()) {
  return mates.map((m) => {
    if (m.name) seen.set(m.id, m.name);
    return { uid: m.id, name: seen.get(m.id) ?? '친구', color: m.color ?? 0, online: m.me || m.online };
  });
}

async function imageSize(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return { width: img.naturalWidth, height: img.naturalHeight };
}

// Built-in key -> its file. The teacher's picture is read once through its signed URL into a
// blob: URL (allowed by the CSP img-src everywhere, and it does not expire mid-class).
// Built-in pictures carry their credit line (teachers' pictures have none).
export async function loadPictureInfo(setup, fetchImpl = globalThis.fetch) {
  if (setup.builtinKey) {
    const response = await fetchImpl(BUILTIN_INDEX);
    if (!response.ok) throw new Error(`built-in pictures: HTTP ${response.status}`);
    const found = (await response.json()).images.find((image) => image.key === setup.builtinKey);
    if (!found) throw new Error(`unknown built-in picture: ${setup.builtinKey}`);
    const credit = found.credit || undefined;
    return { src: found.src, width: found.width, height: found.height, credit, revoke: () => {} };
  }
  if (!setup.pictureUrl) throw new Error('the class picture has no address');
  const response = await fetchImpl(setup.pictureUrl, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`picture: HTTP ${response.status}`);
  const src = URL.createObjectURL(await response.blob());
  try {
    return { src, ...(await imageSize(src)), revoke: () => URL.revokeObjectURL(src) };
  } catch (error) {
    URL.revokeObjectURL(src);
    throw error;
  }
}

/**
 * Opens the puzzle of my group. Returns a handle at once; `ready` settles when the screen is up
 * (or rejects when it could not open). Board states and events given before that are kept.
 * @param {object} options
 * @param {HTMLElement} options.main
 * @param {ReturnType<import('./live.js').connectClass>} options.live
 * @param {object} options.setup     session part of the state (grid, seed, picture, hints, startedAt)
 * @param {string} options.memberId
 * @param {number} options.groupNumber
 * @param {Array} options.mates      model mates
 * @param {object} options.board     my group's board from the state
 * @param {number} options.serverNow
 */
export function openPuzzle({ main, live, setup, memberId, groupNumber, mates, board, serverNow }) {
  let disposed = false;
  let store = null;
  let screen = null;
  let picture = null;
  let celebrated = false;
  let currentMates = mates;
  let latest = { board, serverNow };
  let pending = []; // event batches while the store does not exist yet
  let connected = true;
  let removeHook = () => {};
  let unsubscribe = () => {};
  const seenNames = new Map();
  const band = h('p', { class: 'st-band', role: 'status', hidden: true }, h('i', { class: 'dot' }), '연결이 끊겼어요. 다시 연결하는 중이에요…');

  function celebrate() {
    if (celebrated || disposed) return;
    celebrated = true;
    const state = store.getState();
    screen?.destroy();
    screen = null;
    renderCelebration(main, {
      groupNumber,
      names: membersFromMates(currentMates, seenNames)
        .filter((m) => seenNames.has(m.uid))
        .map((m) => m.name),
      picture: state.picture,
      durationMs: (state.completedAt ?? Date.now()) - state.startedAt,
      pieceCount: state.progress.total,
    });
  }

  function onVisibility() {
    if (disposed || !store) return;
    if (document.visibilityState === 'hidden') {
      // The screen lets go of a dragged piece itself (play-screen.js); this lets go on the server.
      store.release().catch((error) => console.error(error));
    } else {
      live.sync();
    }
  }

  async function open() {
    const loaded = await loadPictureInfo(setup);
    if (disposed) {
      loaded.revoke();
      return null;
    }
    picture = loaded;
    store = createRemoteStore({
      api: live.api,
      me: memberId,
      layout: layoutFor(setup.cols, setup.rows, setup.aspect),
      seed: Number(setup.seed),
      picture: {
        src: picture.src,
        width: picture.width,
        height: picture.height,
        ...(picture.credit ? { credit: picture.credit } : {}),
      },
      groupName: `${groupNumber}모둠`,
      hints: setup.hints,
      members: membersFromMates(currentMates, seenNames),
      startedAt: setup.startedAt,
      board: latest.board,
      serverNow: latest.serverNow,
      onMismatch: () => live.sync(),
    });
    for (const list of pending) store.applyEvents(list);
    pending = [];

    if (store.getState().progress.complete) celebrate();
    else {
      screen = await mountPlayScreen(main, store, { onComplete: celebrate });
      if (disposed) return null;
      document.title = `${groupNumber}모둠 퍼즐 | 함께 퍼즐`;
      (main.querySelector('.pz-board') ?? main).append(band);
      band.hidden = connected;
    }
    // A board that arrives complete (a missed moment, a fresh state) completes too.
    unsubscribe = store.subscribe((state) => {
      if (state.progress.complete) celebrate();
    });
    document.addEventListener('visibilitychange', onVisibility);

    // Test hook (local stack only, test-hooks.js): read-only state and the board camera.
    removeHook = exposeTestHook('__puzzle', {
      state: () => store.getState(),
      camera: () => screen?.board.camera ?? null,
      boardToClient: (x, y) => screen?.board.boardToClient(x, y) ?? null,
      dragging: () => screen?.board.dragging ?? null,
      holders: () => screen?.board.holders ?? [],
      sync: () => live.sync(),
    });
    return handle;
  }

  const handle = {
    groupNumber,
    get store() {
      return store;
    },
    ready: null,
    applyBoard(next, now) {
      if (disposed) return;
      if (store) store.applyBoard(next, now);
      else {
        latest = { board: next, serverNow: now };
        pending = [];
      }
    },
    applyEvents(list) {
      if (disposed || !list.length) return;
      if (store) store.applyEvents(list);
      else pending.push(list);
    },
    setMates(next) {
      currentMates = next;
      store?.setMembers(membersFromMates(next, seenNames));
    },
    setConnected(ok) {
      connected = ok;
      band.hidden = ok;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      screen?.destroy();
      store?.dispose();
      picture?.revoke();
      band.remove();
      removeHook();
    },
  };
  handle.ready = open();
  return handle;
}
