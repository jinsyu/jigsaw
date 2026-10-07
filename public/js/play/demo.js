// /play?demo=1 — solo puzzle on the built-in sea picture, kept in memory.
// &pieces=12|24|48|70 picks the piece count (default 24); help settings (spec rule 10):
// &preview=1 &outline=0 &picture=0 &underlay=1 (1 = on, 0 = off, missing = default).
// For development and demonstrations only: no server, nothing is saved.
import { PIECE_COUNTS, gridFor, layoutFor } from '../puzzle/geometry.js';
import { createLocalStore, shuffledPieces } from '../store/local-store.js';
import { mountPlayScreen } from './play-screen.js';

const PICTURE = { src: '/images/demo/sea.svg', width: 600, height: 400 };
const DEFAULT_PIECES = 24;
const SEED = 42;
const ME = 'demo';

// Piece count from the page address; anything but a supported count gives the default.
export function demoPieceCount(search) {
  const n = Number(new URLSearchParams(search).get('pieces'));
  return PIECE_COUNTS.includes(n) ? n : DEFAULT_PIECES;
}

const HINT_PARAMS = { preview: 'preview', outline: 'outline', picture: 'pictureButton', underlay: 'underlay' };

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

export function createDemoStore(pieceCount = DEFAULT_PIECES, hints = {}) {
  const aspect = PICTURE.width / PICTURE.height;
  const { cols, rows } = gridFor(pieceCount, aspect);
  return createLocalStore({
    layout: layoutFor(cols, rows, aspect),
    seed: SEED,
    picture: PICTURE,
    groupName: '혼자 연습',
    me: ME,
    members: [{ uid: ME, name: '나', color: 0 }],
    trays: { [ME]: shuffledPieces(pieceCount, SEED) },
    hints,
  });
}

export async function startDemo(main) {
  const store = createDemoStore(demoPieceCount(location.search), demoHints(location.search));
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
