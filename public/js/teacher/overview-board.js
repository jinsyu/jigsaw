// Group boards for 모둠 한눈에 보기: the real frame and pieces, drawn read-only from the
// session_overview snapshot with the student screen's geometry, sprites and frame (play/*).
//
// Cost (spec risk: whiteboard PCs and tablets): every group of a session has the same pieces
// (one seed), so one sprite cache serves all small boards and another the big one. Sprites are
// rendered a few at a time between frames (no long task), and a board is drawn again only when
// its snapshot changed or it was resized: a 3-second refresh of six 70-piece boards blits
// at most 6 x 140 small bitmaps. Pieces that moved since the last refresh slide to their new
// place unless reduced motion is asked for.
import { makePuzzle } from '../puzzle/geometry.js';
import { createSpriteCache } from '../play/sprites.js';
import { createFrameLayer, frameRect } from '../play/frame.js';

const MAX_DPR = 2;
const SPRITE_STEP_MS = 5;
const SLIDE_MS = 450;
// A finished board zooms in on the frame (mockup: the completed picture, bigger).
const DONE_MARGIN = 0.08;
// CSS px kept free under a finished picture for the '완성 · 9분 12초' badge (teacher.css
// .t-ov-badge: bottom 14px + about 40px tall; 20px + 46px in the big view), so it never covers it.
const BADGE_ROOM = { mini: 64, zoom: 84 };
const SHADOW_ALPHA = 0.2;

const easeOut = (t) => 1 - (1 - t) ** 3;
let motionQuery;
function calm() {
  motionQuery ??= window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  return motionQuery?.matches === true;
}

/**
 * Shared drawing material for one session.
 * @param {{ layout: object, seed: number, picture: HTMLCanvasElement, hints: { outline: boolean, underlay: boolean } }} options
 */
export function createBoardArt({ layout, seed, picture, hints }) {
  const puzzle = makePuzzle(layout, seed);
  const look = { outline: hints.outline !== false, underlay: hints.underlay ? picture : null };
  const kinds = new Map(); // kind -> { cache, ready, pending, listeners }

  function kindOf(name) {
    let kind = kinds.get(name);
    if (!kind) {
      kind = { cache: createSpriteCache({ puzzle, layout, picture }), ready: false, pending: false, listeners: new Set(), frame: 0 };
      kinds.set(name, kind);
    }
    return kind;
  }

  function stepKind(kind) {
    kind.frame = 0;
    kind.pending = kind.cache.step(performance.now() + SPRITE_STEP_MS);
    if (kind.pending) {
      kind.frame = requestAnimationFrame(() => stepKind(kind));
      return;
    }
    kind.ready = true;
    for (const listener of kind.listeners) listener();
  }

  return {
    layout,
    puzzle,
    look,
    sprites: (name) => kindOf(name).cache,
    isReady: (name) => kindOf(name).ready,
    // Asks for sprites at `px` device pixels per unit; `onReady` runs once they are all drawn.
    want(name, px) {
      const kind = kindOf(name);
      if (kind.cache.setPixelScale(px) && !kind.frame) kind.frame = requestAnimationFrame(() => stepKind(kind));
    },
    listen(name, listener) {
      const kind = kindOf(name);
      kind.listeners.add(listener);
      return () => kind.listeners.delete(listener);
    },
    dispose() {
      for (const kind of kinds.values()) {
        cancelAnimationFrame(kind.frame);
        kind.listeners.clear();
      }
    },
  };
}

/**
 * One board canvas inside `host` (sized by CSS). kind: 'mini' or 'zoom' (separate sprite sizes).
 * @returns {{ setState(state: { clusters: object[], done: boolean, colors: Map<string, string> }): void, resize(): void, destroy(): void, canvas: HTMLCanvasElement }}
 */
export function createBoardCanvas(host, art, kind) {
  const { layout, puzzle } = art;
  const canvas = document.createElement('canvas');
  canvas.className = 't-ov-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const frameLayer = createFrameLayer(layout, puzzle, art.look);
  const sprites = art.sprites(kind);
  const frame = frameRect(layout);

  let size = { w: 0, h: 0, dpr: 1 };
  let cam = { scale: 1, x: 0, y: 0 };
  let state = { clusters: [], done: false, colors: new Map() };
  const shown = new Map(); // piece index -> { x, y, fromX, fromY, toX, toY, t0 }
  let raf = 0;
  let first = true;

  const stopListening = art.listen(kind, () => request());

  function fitCamera() {
    const rect = state.done
      ? {
          x0: frame.x0 - layout.width * DONE_MARGIN,
          y0: frame.y0 - layout.height * DONE_MARGIN,
          x1: frame.x1 + layout.width * DONE_MARGIN,
          y1: frame.y1 + layout.height * DONE_MARGIN,
        }
      : { x0: 0, y0: 0, x1: layout.boardWidth, y1: layout.boardHeight };
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    const room = state.done ? Math.min(BADGE_ROOM[kind] ?? 0, size.h * 0.4) : 0;
    const areaH = Math.max(1, size.h - room);
    const scale = Math.min(size.w / w, areaH / h) || 1;
    cam = { scale, x: (size.w - w * scale) / 2 - rect.x0 * scale, y: (areaH - h * scale) / 2 - rect.y0 * scale };
    frameLayer.setScale(scale, size.dpr);
    art.want(kind, scale * size.dpr);
  }

  function resize() {
    const box = host.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    fitCamera();
    request();
  }

  function setState(next) {
    const wasDone = state.done;
    state = next;
    const now = performance.now();
    const slide = !first && !calm();
    for (const cluster of next.clusters) {
      for (const index of cluster.pieces) {
        const p = shown.get(index);
        if (!p) {
          shown.set(index, { x: cluster.x, y: cluster.y, toX: cluster.x, toY: cluster.y, t0: null });
        } else if (p.toX !== cluster.x || p.toY !== cluster.y) {
          if (slide) Object.assign(p, { fromX: p.x, fromY: p.y, toX: cluster.x, toY: cluster.y, t0: now });
          else Object.assign(p, { x: cluster.x, y: cluster.y, toX: cluster.x, toY: cluster.y, t0: null });
        }
      }
    }
    first = false;
    if (wasDone !== next.done) fitCamera();
    request();
  }

  function request() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function step(now) {
    let moving = false;
    for (const p of shown.values()) {
      if (p.t0 === null) continue;
      const t = Math.min(1, (now - p.t0) / SLIDE_MS);
      const e = easeOut(t);
      p.x = p.fromX + (p.toX - p.fromX) * e;
      p.y = p.fromY + (p.toY - p.fromY) * e;
      if (t >= 1) p.t0 = null;
      else moving = true;
    }
    return moving;
  }

  function draw(now) {
    raf = 0;
    if (!size.w) return;
    const moving = step(now);
    const k = size.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frameLayer.draw(ctx, cam, k);
    if (art.isReady(kind)) {
      ctx.setTransform(k * cam.scale, 0, 0, k * cam.scale, k * cam.x, k * cam.y);
      const shadowShift = 2 / cam.scale;
      for (const cluster of state.clusters) {
        if (!cluster.locked) {
          ctx.globalAlpha = SHADOW_ALPHA;
          for (const i of cluster.pieces) blit(sprites.get(i).shadow, i, shadowShift * 0.6, shadowShift);
          ctx.globalAlpha = 1;
        }
        for (const i of cluster.pieces) blit(sprites.get(i).body, i, 0, 0);
      }
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.5 / cam.scale;
      for (const cluster of state.clusters) {
        const color = cluster.heldBy ? state.colors.get(cluster.heldBy) : null;
        if (!color) continue;
        ctx.strokeStyle = color;
        for (const i of cluster.pieces) {
          const p = shown.get(i);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.stroke(sprites.paths[i]);
          ctx.restore();
        }
      }
    }
    if (moving) request();
  }

  function blit(image, index, dx, dy) {
    const p = shown.get(index);
    const box = sprites.boxes[index];
    ctx.drawImage(image, p.x + box.x + dx, p.y + box.y + dy, box.w, box.h);
  }

  return {
    canvas,
    setState,
    resize,
    destroy() {
      cancelAnimationFrame(raf);
      raf = 0;
      stopListening();
      canvas.remove();
    },
  };
}
