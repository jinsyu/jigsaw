// Puzzle geometry shared by every screen. The server never stores shapes:
// every device rebuilds the same pieces from sessions.seed.
//
// Coordinate convention (board units, all float64):
// - Completed picture: width = cols * 100, height = width / aspect,
//   where aspect = picture width / picture height.
// - Piece cell (col, row) covers [col * pw, (col + 1) * pw] x [row * ph, (row + 1) * ph]
//   in picture coordinates, with pw = 100 and ph = height / rows.
// - A cluster position (x, y) is where the picture origin sits on the board.
//   Piece (col, row) of that cluster is drawn translated by (x, y).
// - Board: [0, boardWidth] x [0, boardHeight] with boardWidth = width * sqrt(3)
//   and boardHeight = height * sqrt(3), i.e. three times the picture area.

export const PIECE_UNIT = 100;
export const PIECE_COUNTS = [12, 24, 48, 70];
// Board side / picture side (spec rule 5). SQL jigsaw_private.resolve_drop uses sqrt(3::float8):
// both are the correctly rounded square root, so the board size is bit-identical.
export const BOARD_SIDE_RATIO = Math.sqrt(3);

// [cols, rows] for a landscape (or square) picture; portrait swaps them.
const LANDSCAPE_GRIDS = { 12: [4, 3], 24: [6, 4], 48: [8, 6], 70: [10, 7] };

// xorshift32: tiny and identical on every JS engine.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function assertAspect(aspect) {
  if (!(Number.isFinite(aspect) && aspect > 0)) {
    throw new RangeError(`aspect must be a positive number: ${aspect}`);
  }
}

export function gridFor(pieceCount, aspect) {
  assertAspect(aspect);
  const grid = LANDSCAPE_GRIDS[pieceCount];
  if (!grid) throw new RangeError(`unsupported piece count: ${pieceCount}`);
  const [long, short] = grid;
  return aspect >= 1 ? { cols: long, rows: short } : { cols: short, rows: long };
}

// Keep the operation order (width / aspect, then / rows) in sync with SQL.
export function layoutFor(cols, rows, aspect) {
  assertAspect(aspect);
  const width = cols * PIECE_UNIT;
  const height = width / aspect;
  return {
    cols,
    rows,
    aspect,
    width,
    height,
    pw: PIECE_UNIT,
    ph: height / rows,
    boardWidth: width * BOARD_SIDE_RATIO,
    boardHeight: height * BOARD_SIDE_RATIO,
  };
}

// One side A -> B as cubic Bézier segments [p0, c1, c2, p3].
// N: unit normal toward the tab side, s: +1 / -1 (tab direction) or 0 (flat border).
function edge(A, B, N, s, j) {
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const L = Math.hypot(dx, dy);
  const m = ([u, v]) => [A[0] + u * dx + v * L * s * N[0], A[1] + u * dy + v * L * s * N[1]];
  if (!s) return [[A, m([1 / 3, 0]), m([2 / 3, 0]), B]];
  const c = 0.5 + j.cx;
  const k = j.k;
  const uv = [
    [[0, 0], [(c - 0.15 * k) / 3, 0], [(2 * (c - 0.15 * k)) / 3, 0], [c - 0.15 * k, 0]],
    [[c - 0.15 * k, 0], [c - 0.06 * k, 0], [c - 0.04 * k, 0.04 * k], [c - 0.07 * k, 0.08 * k]],
    [[c - 0.07 * k, 0.08 * k], [c - 0.13 * k, 0.14 * k], [c - 0.13 * k, 0.27 * k], [c, 0.27 * k]],
    [[c, 0.27 * k], [c + 0.13 * k, 0.27 * k], [c + 0.13 * k, 0.14 * k], [c + 0.07 * k, 0.08 * k]],
    [[c + 0.07 * k, 0.08 * k], [c + 0.04 * k, 0.04 * k], [c + 0.06 * k, 0], [c + 0.15 * k, 0]],
    [
      [c + 0.15 * k, 0],
      [c + 0.15 * k + (1 - c - 0.15 * k) / 3, 0],
      [c + 0.15 * k + (2 * (1 - c - 0.15 * k)) / 3, 0],
      [1, 0],
    ],
  ];
  return uv.map((seg) => seg.map(m));
}

const reverse = (segs) => segs.slice().reverse().map(([a, b, c, d]) => [d, c, b, a]);
const fmt = (n) => n.toFixed(2);

function toSvgPath(segments) {
  let d = `M${fmt(segments[0][0][0])} ${fmt(segments[0][0][1])}`;
  for (const [, c1, c2, p] of segments) {
    d += `C${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(p[0])} ${fmt(p[1])}`;
  }
  return `${d}Z`;
}

// Piece outlines in picture coordinates. Each piece has
// { index, col, row, x0, y0, segments, d } where d is an SVG path string.
export function makePuzzle({ cols, rows, width, height }, seed) {
  const r = rng(seed);
  const pw = width / cols;
  const ph = height / rows;
  const jitter = () => ({ cx: (r() - 0.5) * 0.08, k: 0.92 + r() * 0.16 });
  const sign = () => (r() < 0.5 ? 1 : -1);

  const horizontal = [];
  const vertical = [];
  for (let y = 1; y < rows; y++) {
    horizontal[y] = [];
    for (let x = 0; x < cols; x++) {
      horizontal[y][x] = edge([x * pw, y * ph], [(x + 1) * pw, y * ph], [0, 1], sign(), jitter());
    }
  }
  for (let x = 1; x < cols; x++) {
    vertical[x] = [];
    for (let y = 0; y < rows; y++) {
      vertical[x][y] = edge([x * pw, y * ph], [x * pw, (y + 1) * ph], [1, 0], sign(), jitter());
    }
  }

  const pieces = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * pw;
      const y0 = row * ph;
      const x1 = x0 + pw;
      const y1 = y0 + ph;
      const top = row === 0 ? edge([x0, y0], [x1, y0], [0, 1], 0) : horizontal[row][col];
      const right = col === cols - 1 ? edge([x1, y0], [x1, y1], [1, 0], 0) : vertical[col + 1][row];
      const bottom =
        row === rows - 1 ? edge([x1, y1], [x0, y1], [0, 1], 0) : reverse(horizontal[row + 1][col]);
      const left = col === 0 ? edge([x0, y1], [x0, y0], [1, 0], 0) : reverse(vertical[col][row]);
      const segments = [top, right, bottom, left].flat();
      pieces.push({ index: pieces.length, col, row, x0, y0, segments, d: toSvgPath(segments) });
    }
  }
  return { cols, rows, width, height, pw, ph, pieces, at: (col, row) => pieces[row * cols + col] };
}

// Draws the outline onto anything with the CanvasPath methods
// (CanvasRenderingContext2D or Path2D).
export function traceOutline(target, piece) {
  const [start] = piece.segments[0];
  target.moveTo(start[0], start[1]);
  for (const [, c1, c2, p] of piece.segments) {
    target.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p[0], p[1]);
  }
  target.closePath();
}

export function toPath2D(piece) {
  const path = new Path2D();
  traceOutline(path, piece);
  return path;
}
