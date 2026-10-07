// Puzzle store contract: the only way the student puzzle screen reads or changes
// puzzle data. T10 ships an in-memory implementation (local-store.js); T11 adds a
// Supabase RPC implementation with the same shape, so the screen does not change.
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
 *
 * @typedef {object} Member
 * @property {string} uid
 * @property {string} name     Display only; never stored on the server (spec D14).
 * @property {number} color    0-based index into the member colours.
 * @property {boolean} online
 *
 * @typedef {object} PuzzleState  Read-only snapshot. A new object is created on every change.
 * @property {object} layout   geometry.layoutFor() result.
 * @property {number} seed     Shape seed (sessions.seed).
 * @property {{ src: string, width: number, height: number }} picture
 * @property {string} groupName
 * @property {string} me       uid of this device's member.
 * @property {Member[]} members
 * @property {number[]} tray   Piece indexes (row * cols + col) in MY tray only.
 * @property {Cluster[]} clusters  Clusters on the board, sorted by z.
 * @property {{ placed: number, total: number, complete: boolean }} progress
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

export const cellOfPiece = (index, cols) => [index % cols, Math.floor(index / cols)];
export const pieceOfCell = ([col, row], cols) => row * cols + col;
