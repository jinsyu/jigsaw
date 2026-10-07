// Completed-picture frame in the middle of the board: every piece outline is
// drawn faintly where the picture goes, so even an empty board shows where
// pieces belong.
import { traceOutline } from '../puzzle/geometry.js';

// Frame origin T: the picture centred on the board.
// TODO(T5): use snap.frameOrigin(layout) here once T5 is merged, so drawing and
// snapping share one definition.
export function frameOrigin(layout) {
  return {
    x: (layout.boardWidth - layout.width) / 2,
    y: (layout.boardHeight - layout.height) / 2,
  };
}

export function frameRect(layout) {
  const { x, y } = frameOrigin(layout);
  return { x0: x, y0: y, x1: x + layout.width, y1: y + layout.height };
}

// Line widths are in CSS pixels at every zoom level.
const STYLE = {
  fill: '#FBF8F1',
  seam: 'rgba(96, 78, 52, 0.36)',
  seamPx: 1.25,
  edge: 'rgba(96, 78, 52, 0.45)',
  edgePx: 2,
};
// Above this the frame is stroked directly instead of kept as a bitmap (deep zoom on big puzzles).
const MAX_BITMAP_PIXELS = 4e6;

// Draws the frame with its top-left at (0, 0) in the current transform, `scale` = CSS px per unit.
function paint(c, outlines, layout, scale) {
  c.fillStyle = STYLE.fill;
  c.fillRect(0, 0, layout.width, layout.height);
  c.lineJoin = 'round';
  c.strokeStyle = STYLE.seam;
  c.lineWidth = STYLE.seamPx / scale;
  c.stroke(outlines);
  c.strokeStyle = STYLE.edge;
  c.lineWidth = STYLE.edgePx / scale;
  c.strokeRect(0, 0, layout.width, layout.height);
}

/**
 * Frame drawn once into a bitmap for the settled zoom and blitted every frame.
 * @param {object} layout  geometry.layoutFor() result
 * @param {{ pieces: object[] }} puzzle  geometry.makePuzzle() result
 */
export function createFrameLayer(layout, puzzle) {
  const origin = frameOrigin(layout);
  const outlines = new Path2D();
  for (const piece of puzzle.pieces) traceOutline(outlines, piece);
  const canvas = document.createElement('canvas');
  let bitmap = null; // { px, margin } once `canvas` holds the frame at px device pixels per unit

  return {
    // Re-render for a settled zoom. scale: CSS px per unit, dpr: device px per CSS px.
    setScale(scale, dpr) {
      const px = scale * dpr;
      if (bitmap?.px === px) return;
      const margin = Math.ceil(STYLE.edgePx * dpr) + 1;
      const w = Math.ceil(layout.width * px) + 2 * margin;
      const h = Math.ceil(layout.height * px) + 2 * margin;
      if (w * h > MAX_BITMAP_PIXELS) {
        bitmap = null;
        canvas.width = canvas.height = 1; // free the memory
        return;
      }
      canvas.width = w;
      canvas.height = h;
      const c = canvas.getContext('2d');
      c.setTransform(px, 0, 0, px, margin, margin);
      paint(c, outlines, layout, scale);
      bitmap = { px, margin };
    },

    // cam: { scale, x, y } in CSS px; dpr as above. Leaves ctx with the identity transform
    // (bitmap) or a world transform (stroked): the caller sets its own transform after.
    draw(ctx, cam, dpr) {
      const px = cam.scale * dpr;
      const sx = dpr * cam.x + origin.x * px;
      const sy = dpr * cam.y + origin.y * px;
      if (!bitmap) {
        ctx.setTransform(px, 0, 0, px, sx, sy);
        paint(ctx, outlines, layout, cam.scale);
        return;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (bitmap.px === px) {
        // Whole device pixels keep the thin lines sharp.
        ctx.drawImage(canvas, Math.round(sx - bitmap.margin), Math.round(sy - bitmap.margin));
      } else {
        // Mid-gesture: stretch the last bitmap until the zoom settles.
        const r = px / bitmap.px;
        ctx.drawImage(canvas, sx - bitmap.margin * r, sy - bitmap.margin * r, canvas.width * r, canvas.height * r);
      }
    },
  };
}
