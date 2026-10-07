// Puzzle store contract: the only way the student puzzle screen reads or changes
// puzzle data. local-store.js keeps it in memory (demo); remote-store.js talks to the rt
// server over its socket with the same shape, so the screen does not change.
//
// Every action returns a Promise and never throws for rule violations; it resolves
// to { ok: false, reason } instead. Listeners are called after the state changed.

/**
 * @typedef {[number, number]} Cell  [col, row] of a piece in the completed picture.
 *
 * @typedef {object} Cluster  Pieces stuck together. (x, y) is where the picture origin sits on the board.
 * @property {number} id
 * @property {number} x
 * @property {number} y
 * @property {number} z        Drawing order, larger is on top.
 * @property {Cell[]} pieces
 * @property {string|null} heldBy  uid of the member holding it, or null.
 * @property {number|null} [heldAt]  When heldBy grabbed it (ms since epoch), or null.
 *   Remote stores pass the server's grab time: holds are judged
 *   by time like the server does (snap.js isHeldByOther, 10 s). Without heldAt the
 *   screen treats a hold as fresh.
 * @property {boolean} [locked]  In the frame for good: cannot be grabbed (snap.js rule 6).
 *
 * @typedef {object} Member
 * @property {string} uid
 * @property {string} name     Display only; never stored on the server (spec D14).
 * @property {number} color    0-based index into the member colours.
 * @property {boolean} online
 *
 * @typedef {object} Hints  Help settings, the same for every group of a session.
 * @property {boolean} preview        Show where a dragged piece would snap (cell / edges in green,
 *                                    and the light tug toward it). Snapping itself always works. Default false.
 * @property {boolean} outline        Piece outlines inside the frame; off = frame border only. Default true.
 * @property {boolean} pictureButton  The "completed picture" button. Default true.
 * @property {boolean} underlay       The completed picture very faint inside the frame. Default false.
 *
 * @typedef {object} PuzzleState  Read-only snapshot. A new object is created on every change.
 * @property {object} layout   geometry.layoutFor() result.
 * @property {number} seed     Shape seed (sessions.seed).
 * @property {{ src: string, width: number, height: number, credit?: string }} picture
 *   credit: the source line of an outside built-in picture (index.json credit), shown under
 *   the completed picture. Leave it out for self-made and teachers' own pictures.
 * @property {string} groupName
 * @property {string} me       uid of this device's member.
 * @property {Member[]} members
 * @property {number[]} tray   Piece indexes (row * cols + col) in MY tray only.
 * @property {Cluster[]} clusters  Clusters on the board, sorted by z.
 * @property {{ placed: number, total: number, complete: boolean }} progress
 * @property {Hints} hints   Help settings the teacher picked for the session (spec rule 10).
 * @property {number} startedAt    ms since epoch.
 * @property {number|null} completedAt
 *
 * @typedef {object} PuzzleStore
 * @property {() => PuzzleState} getState
 * @property {(listener: (state: PuzzleState, change: object) => void) => () => void} subscribe
 * @property {(piece: number, x: number, y: number) => Promise<{ ok: true, clusterId: number } | { ok: false, reason: string }>} takeFromTray
 *   Puts one of my tray pieces on the board at (x, y) (picture origin), held by me. Follow with drop().
 * @property {(clusterId: number) => Promise<{ ok: boolean, reason?: string, heldBy?: string }>} grab
 * @property {(clusterId: number, x: number, y: number) => Promise<object>} drop
 *   Clamps, snaps (snap.js rules) and releases. Resolves to
 *   { ok: true, id, x, y, absorbed, progress } where id is the surviving cluster.
 * @property {() => void} dispose
 */

export const PUZZLE_STORE_METHODS = ['getState', 'subscribe', 'takeFromTray', 'grab', 'drop', 'dispose'];

export function isPuzzleStore(store) {
  return !!store && PUZZLE_STORE_METHODS.every((name) => typeof store[name] === 'function');
}

export const DEFAULT_HINTS = Object.freeze({ preview: false, outline: true, pictureButton: true, underlay: false });

// Fills missing or non-boolean values with the defaults.
export function normalizeHints(hints = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_HINTS)) {
    out[key] = typeof hints?.[key] === 'boolean' ? hints[key] : fallback;
  }
  return Object.freeze(out);
}

// sessions row (hint_* columns of jigsaw.sessions) -> Hints.
export function hintsFromSession(row) {
  return normalizeHints({
    preview: row?.hint_preview,
    outline: row?.hint_outline,
    pictureButton: row?.hint_picture_button,
    underlay: row?.hint_underlay,
  });
}

export const cellOfPiece = (index, cols) => [index % cols, Math.floor(index / cols)];
export const pieceOfCell = ([col, row], cols) => row * cols + col;
