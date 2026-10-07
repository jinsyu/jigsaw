// /play?demo=1 — solo puzzle on a built-in picture, kept in memory.
// &picture=<key> picks the built-in picture (public/images/builtin/index.json, default sea);
// &pieces=12|24|48|70 picks the piece count (default 24); help settings (spec rule 10):
// &preview=1 &outline=0 &button=0 &underlay=1 (1 = on, 0 = off, missing = default;
// button = the completed picture button).
// For development and demonstrations only: no server, nothing is saved.
import { PIECE_COUNTS, gridFor, layoutFor } from '../puzzle/geometry.js';
import { createLocalStore, shuffledPieces } from '../store/local-store.js';
import { mountPlayScreen } from './play-screen.js';

const BUILTIN_INDEX = '/images/builtin/index.json';
const DEFAULT_PICTURE_KEY = 'sea';
const DEFAULT_PICTURE = { src: '/images/builtin/sea.webp', width: 1800, height: 1200 };
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

// Built-in picture key from the page address.
export function demoPictureKey(search) {
  const value = new URLSearchParams(search).get('picture');
  return value && /^[a-z0-9-]{1,64}$/.test(value) ? value : DEFAULT_PICTURE_KEY;
}

// { src, width, height } of a built-in picture; unknown keys give the default.
export async function loadDemoPicture(key) {
  if (key === DEFAULT_PICTURE_KEY) return DEFAULT_PICTURE;
  const response = await fetch(BUILTIN_INDEX);
  if (!response.ok) throw new Error(`built-in pictures: ${response.status}`);
  const found = (await response.json()).images.find((image) => image.key === key);
  return found ? { src: found.src, width: found.width, height: found.height } : DEFAULT_PICTURE;
}

export function createDemoStore(pieceCount = DEFAULT_PIECES, hints = {}, picture = DEFAULT_PICTURE) {
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

export async function startDemo(main) {
  const picture = await loadDemoPicture(demoPictureKey(location.search));
  const store = createDemoStore(demoPieceCount(location.search), demoHints(location.search), picture);
  const screen = await mountPlayScreen(main, store);
  // Test and demo hook: read-only view of the state and the board camera.
  window.__puzzleDemo = {
    state: () => store.getState(),
    camera: () => screen.board.camera,
    preview: () => screen.board.preview,
    animating: () => screen.board.animating,
    boardToClient: (x, y) => screen.board.boardToClient(x, y),
  };
}
