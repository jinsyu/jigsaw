// /play?demo=1 — solo 24-piece puzzle on the built-in sea picture, kept in memory.
// For development and demonstrations only: no server, nothing is saved.
import { gridFor, layoutFor } from '../puzzle/geometry.js';
import { createLocalStore, shuffledPieces } from '../store/local-store.js';
import { mountPlayScreen } from './play-screen.js';

const PICTURE = { src: '/images/demo/sea.svg', width: 600, height: 400 };
const PIECE_COUNT = 24;
const SEED = 42;
const ME = 'demo';

export function createDemoStore() {
  const aspect = PICTURE.width / PICTURE.height;
  const { cols, rows } = gridFor(PIECE_COUNT, aspect);
  return createLocalStore({
    layout: layoutFor(cols, rows, aspect),
    seed: SEED,
    picture: PICTURE,
    groupName: '혼자 연습',
    me: ME,
    members: [{ uid: ME, name: '나', color: 0 }],
    trays: { [ME]: shuffledPieces(PIECE_COUNT, SEED) },
  });
}

export async function startDemo(main) {
  const store = createDemoStore();
  const screen = await mountPlayScreen(main, store);
  // Test and demo hook: read-only view of the state and the board camera.
  window.__puzzleDemo = {
    state: () => store.getState(),
    camera: () => screen.board.camera,
    boardToClient: (x, y) => screen.board.boardToClient(x, y),
  };
}
