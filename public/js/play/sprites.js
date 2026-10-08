// Piece bitmaps. Each piece is clipped from the picture once per zoom level and
// reused every frame, so panning and dragging only blit images.
import { toPath2D } from '../puzzle/geometry.js';

// Tabs stick out up to 0.29 of the edge length; PAD leaves room for the seam and shadow blur.
const TAB_MARGIN = 0.3;
const PAD = 5;
const SEAM_COLOR = 'rgba(30, 25, 20, 0.3)';
const SEAM_WIDTH = 1.1;
const SHADOW_COLOR = '#3c2814';
// Keep all sprites together under ~48 MB so 96-piece puzzles fit low-end tablets.
const SPRITE_BUDGET_BYTES = 48e6;
const MAX_PIXELS_PER_UNIT = 4;
const MIN_PIXELS_PER_UNIT = 0.125;

// Piece bounding box (picture units) including tabs and padding.
export function pieceBox(layout, piece) {
  const mx = TAB_MARGIN * layout.ph + PAD;
  const my = TAB_MARGIN * layout.pw + PAD;
  return { x: piece.x0 - mx, y: piece.y0 - my, w: layout.pw + 2 * mx, h: layout.ph + 2 * my };
}

function drawPicturePart(ctx, picture, layout, box) {
  const k = picture.width / layout.width;
  // Only the part inside the picture: Safari draws nothing for out-of-range source rects.
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(layout.width, box.x + box.w);
  const y1 = Math.min(layout.height, box.y + box.h);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.drawImage(picture, x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k, x0, y0, x1 - x0, y1 - y0);
}

// Draws one piece so that its box's top-left lands on (0, 0) at `scale` px per unit.
export function drawPiece(ctx, { piece, path, picture, layout, scale }) {
  const box = pieceBox(layout, piece);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-box.x, -box.y);
  ctx.save();
  ctx.clip(path);
  drawPicturePart(ctx, picture, layout, box);
  ctx.restore();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = SEAM_COLOR;
  ctx.lineWidth = SEAM_WIDTH;
  ctx.stroke(path);
  ctx.restore();
}

function drawShadow(ctx, { piece, path, layout, scale }) {
  const box = pieceBox(layout, piece);
  ctx.save();
  if ('filter' in ctx) ctx.filter = `blur(${Math.max(0.5, 2 * scale).toFixed(2)}px)`;
  ctx.scale(scale, scale);
  ctx.translate(-box.x, -box.y);
  ctx.fillStyle = SHADOW_COLOR;
  ctx.fill(path);
  ctx.restore();
}

function newCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  return canvas;
}

export function createSpriteCache({ puzzle, layout, picture }) {
  const paths = puzzle.pieces.map((piece) => toPath2D(piece));
  const boxes = puzzle.pieces.map((piece) => pieceBox(layout, piece));
  const longest = Math.max(boxes[0].w, boxes[0].h);
  const budgetPx = Math.sqrt(SPRITE_BUDGET_BYTES / (4 * puzzle.pieces.length));
  // Beyond the picture's own resolution a bigger sprite adds nothing.
  const pictureLimit = picture.width / layout.width;
  const cap = Math.max(MIN_PIXELS_PER_UNIT, Math.min(MAX_PIXELS_PER_UNIT, budgetPx / longest, pictureLimit * 1.5));
  const entries = new Array(puzzle.pieces.length).fill(null);
  let target = 1;
  let queue = [];

  // Half-octave buckets so small zoom changes reuse the sprites.
  function bucket(px) {
    const stepped = 2 ** (Math.ceil(Math.log2(Math.max(px, 1e-3)) * 2) / 2);
    return Math.min(cap, Math.max(MIN_PIXELS_PER_UNIT, stepped));
  }

  function render(index) {
    const piece = puzzle.pieces[index];
    const box = boxes[index];
    const body = newCanvas(box.w * target, box.h * target);
    drawPiece(body.getContext('2d'), { piece, path: paths[index], picture, layout, scale: target });
    const shadowScale = target / 2;
    const shadow = newCanvas(box.w * shadowScale, box.h * shadowScale);
    drawShadow(shadow.getContext('2d'), { piece, path: paths[index], layout, scale: shadowScale });
    entries[index] = { body, shadow, scale: target };
  }

  return {
    paths,
    boxes,
    get pixelScale() {
      return target;
    },
    // Returns true when sprites must be re-rendered for the new scale.
    setPixelScale(px) {
      const next = bucket(px);
      if (next === target && queue.length === 0 && entries.every(Boolean)) return false;
      target = next;
      queue = entries.map((_, i) => i).filter((i) => entries[i]?.scale !== target);
      return queue.length > 0;
    },
    // Re-renders queued sprites until the deadline; true while work remains.
    step(deadline) {
      while (queue.length && performance.now() < deadline) render(queue.shift());
      return queue.length > 0;
    },
    get(index) {
      if (!entries[index]) render(index);
      return entries[index];
    },
  };
}
