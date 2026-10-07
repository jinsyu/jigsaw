// A student's group puzzle in class: reads the session (grid, seed, picture, help settings),
// opens the Supabase store for the group, mounts the puzzle screen and keeps it going:
// - redistribute_stale every REDISTRIBUTE_MS (idempotent on the server, every screen of the
//   group calls it) so the tray of a student gone for a minute is dealt to the others;
// - back from the background: heartbeat first, then a fresh board and redistribute_stale
//   (otherwise this student's own tray could be dealt away, T6 review);
// - every piece in the frame: the completion screen.
// Names and who is online come in through setMates() (Presence, student/live.js).
import { layoutFor } from '../puzzle/geometry.js';
import { mountPlayScreen } from '../play/play-screen.js';
import { hintsFromSession } from '../store/puzzle-store.js';
import { openRemoteStore } from '../store/remote-store.js';
import { createSupabaseApi } from '../store/supabase-api.js';
import { renderCelebration } from './celebrate.js';

export const REDISTRIBUTE_MS = 20_000;
const BUILTIN_INDEX = '/images/builtin/index.json';
const SESSION_FIELDS =
  'cols, rows, aspect, seed, piece_count, builtin_key, image_id, started_at, ' +
  'hint_preview, hint_outline, hint_picture_button, hint_underlay';

// Members for the store from the live class state. A friend who left keeps the name this
// screen saw while they were here (`seen`: uid -> name, updated here); never seen: '친구'.
export function membersFromMates(mates, seen = new Map()) {
  return mates
    .filter((m) => m.uid)
    .map((m) => {
      if (m.name) seen.set(m.uid, m.name);
      return { uid: m.uid, name: seen.get(m.uid) ?? '친구', color: m.color ?? 0, online: m.me || m.online };
    });
}

// Built-in key -> its file, or the teacher's picture from the private bucket as a blob: URL
// (no expiring signed URL, and blob: is allowed by the CSP img-src everywhere).
async function loadPictureInfo(client, session) {
  if (session.builtin_key) {
    const response = await fetch(BUILTIN_INDEX);
    if (!response.ok) throw new Error(`built-in pictures: HTTP ${response.status}`);
    const found = (await response.json()).images.find((image) => image.key === session.builtin_key);
    if (!found) throw new Error(`unknown built-in picture: ${session.builtin_key}`);
    return { src: found.src, width: found.width, height: found.height, revoke: () => {} };
  }
  if (!session.image_id) throw new Error('the session has no picture');
  const { data: image, error } = await client.from('images').select('path, width, height').eq('id', session.image_id).maybeSingle();
  if (error) throw error;
  if (!image) throw new Error('the picture is not readable');
  const { data: blob, error: downloadError } = await client.storage.from('images').download(image.path);
  if (downloadError) throw downloadError;
  const src = URL.createObjectURL(blob);
  return { src, width: image.width, height: image.height, revoke: () => URL.revokeObjectURL(src) };
}

/**
 * @param {object} options
 * @param {object} options.client     supabase-js (student)
 * @param {HTMLElement} options.main
 * @param {number} options.sessionId
 * @param {{ id: number, number: number }} options.group
 * @param {string} options.userId
 * @param {Array} options.mates       live.js mates
 * @param {{ beat: () => Promise<void>, refresh: () => Promise<void> }} options.live
 * @param {() => void} options.onEnded
 * @param {() => boolean} [options.isCurrent]  false once the student moved on (another group,
 *   class over) while this was loading: nothing is drawn and null is returned.
 */
export async function openPuzzle({ client, main, sessionId, group, userId, mates, live, onEnded, isCurrent = () => true }) {
  let disposed = false;
  let screen = null;
  let celebrated = false;
  let currentMates = mates;
  const seenNames = new Map();

  const { data: session, error } = await client.from('sessions').select(SESSION_FIELDS).eq('id', sessionId).maybeSingle();
  if (error) throw error;
  if (!session) throw new Error('the session is not readable');
  const picture = await loadPictureInfo(client, session);
  const startedAt = Date.parse(session.started_at);
  const store = await openRemoteStore({
    api: createSupabaseApi(client),
    groupId: group.id,
    me: userId,
    layout: layoutFor(session.cols, session.rows, session.aspect),
    seed: Number(session.seed),
    picture: { src: picture.src, width: picture.width, height: picture.height },
    groupName: `${group.number}모둠`,
    hints: hintsFromSession(session),
    members: membersFromMates(mates, seenNames),
    startedAt,
    onEnd: onEnded,
    onNotPlaying: () => live.refresh(),
  }).catch((cause) => {
    picture.revoke();
    throw cause;
  });

  // After time in the background this screen may count as gone itself: signal first.
  let mayBeStale = false;
  async function redistribute() {
    if (disposed || document.visibilityState === 'hidden') return;
    if (mayBeStale) {
      await live.beat();
      mayBeStale = false;
    }
    const { data, error: rpcError } = await client.rpc('redistribute_stale', { p_group: group.id });
    if (rpcError) console.error(rpcError);
    else if (data?.ok && data.pieces?.length) store.onEvent('tray', { pieces: data.pieces });
  }

  function celebrate() {
    if (celebrated || disposed) return;
    celebrated = true;
    const state = store.getState();
    screen?.destroy();
    screen = null;
    renderCelebration(main, {
      groupNumber: group.number,
      names: membersFromMates(currentMates, seenNames)
        .filter((m) => seenNames.has(m.uid))
        .map((m) => m.name),
      picture: state.picture,
      durationMs: (state.completedAt ?? Date.now()) - state.startedAt,
      pieceCount: state.progress.total,
    });
  }

  async function onVisible() {
    if (disposed) return;
    if (document.visibilityState === 'hidden') {
      mayBeStale = true;
      return;
    }
    try {
      await live.beat();
      mayBeStale = false;
      await store.resync();
      await redistribute();
    } catch (cause) {
      console.error(cause);
    }
  }

  if (!isCurrent()) {
    store.dispose();
    picture.revoke();
    return null;
  }
  if (store.getState().progress.complete) celebrate();
  else {
    screen = await mountPlayScreen(main, store, { onComplete: celebrate });
    document.title = `${group.number}모둠 퍼즐 | 함께 퍼즐`;
  }
  // A board reloaded after the drop that finished it (missed broadcast) also completes.
  const unsubscribe = store.subscribe((state) => {
    if (state.progress.complete) celebrate();
  });
  const redistributeTimer = setInterval(() => redistribute().catch((e) => console.error(e)), REDISTRIBUTE_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);

  // Test hook (like window.__puzzleDemo): read-only state and the board camera.
  window.__puzzle = {
    state: () => store.getState(),
    camera: () => screen?.board.camera ?? null,
    boardToClient: (x, y) => screen?.board.boardToClient(x, y) ?? null,
    dragging: () => screen?.board.dragging ?? null,
    holders: () => screen?.board.holders ?? [],
    redistribute,
    resync: () => store.resync(),
  };

  return {
    store,
    setMates(next) {
      currentMates = next;
      store.setMembers(membersFromMates(next, seenNames));
    },
    noteServerTime: (iso, sentAt, receivedAt) => store.noteServerTime(iso, sentAt, receivedAt),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(redistributeTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      unsubscribe();
      screen?.destroy();
      store.dispose();
      picture.revoke();
      delete window.__puzzle;
    },
  };
}
