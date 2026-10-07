// Piece outlines for the "미리보기" on the create screen. Uses the real puzzle
// geometry, so the grid and the knob shapes look like the puzzle students get.
// The session seed is drawn by the server later, so the preview uses a fixed seed.
import { gridFor, layoutFor, makePuzzle } from '../puzzle/geometry.js';

const PREVIEW_SEED = 42;

export function previewOutline(pieceCount, pictureWidth, pictureHeight) {
  const aspect = pictureWidth / pictureHeight;
  const { cols, rows } = gridFor(pieceCount, aspect);
  const layout = layoutFor(cols, rows, aspect);
  const puzzle = makePuzzle(layout, PREVIEW_SEED);
  return { cols, rows, width: layout.width, height: layout.height, paths: puzzle.pieces.map((p) => p.d) };
}
