// Board canvas: draws the frame and clusters from piece sprites and turns pointer
// input into piece drags (one finger or the mouse on a piece), pans and zooms
// (two fingers; the mouse drags empty board and uses the wheel). One finger on
// empty board does nothing, so the board never slides away under a child's hand.
// While a piece is dragged (on the board or from the tray) it shows where it would
// snap. Pieces locked in the frame lie flat and cannot be picked up.
// Clusters a friend holds get the friend's colour as an outline and a name tag
// (setHolders). A piece held still for `holdMs` is let go by itself, and a piece
// that keeps moving asks for its hold to be renewed (onHoldRenew) every `renewMs`.
// It knows nothing about the store: the screen passes clusters and snap
// predictions in and gets onGrab / onDrop / onLockedPress calls out.
import { pieceOfCell } from '../store/puzzle-store.js';
import {
  clampCamera,
  clampScale,
  fitCamera,
  pinchCamera,
  revealCamera,
  screenToBoard,
  boardToScreen,
  viewBoardRect,
  visibleBoardRect,
  zoomAt,
} from './camera.js';
import { createFrameLayer } from './frame.js';
import { pullOffset, sideSegments } from './magnet.js';

const MAX_DPR = 2;
const SLIDE_MS = 220;
const SNAP_MS = 130;
const FLASH_MS = 420;
const LOCK_FLASH_MS = 700;
const SHAKE_MS = 360;
// prefers-reduced-motion: pieces and the view jump instead of sliding, flashes are
// short and do not grow, and a refused locked piece is outlined instead of shaken.
const CALM_FLASH_MS = 260;
const SHAKE_PX = 4;
const REVEAL_MS = 320;
const REVEAL_PAD_PX = 12;
const SPRITE_STEP_MS = 6;
const HIT_SLOP_PX = 10;
// Moving a finger this far on a locked piece counts as trying to drag it.
const LOCKED_DRAG_PX = 8;
// A second finger turns a piece drag into a pinch unless the piece already travelled this far.
const PINCH_TAKEOVER_PX = 30;
const DOT_SPACING = 40;
const COLORS = {
  outside: '#E9E2D5',
  board: '#F3EDE2',
  boardEdge: 'rgba(120, 100, 70, 0.22)',
  dot: 'rgba(120, 100, 70, 0.2)',
  flash: 'rgba(255, 255, 255, 0.95)',
  lockGlow: '255, 196, 0',
  refused: 'rgba(30, 36, 51, 0.55)',
  ghostLine: 'rgba(31, 157, 85, 0.6)',
  placeFill: 'rgba(31, 157, 85, 0.16)',
  placeLine: 'rgba(31, 157, 85, 0.85)',
  edge: '31, 157, 85',
};

const easeOut = (t) => 1 - (1 - t) ** 3;
let motionQuery;
function calm() {
  motionQuery ??= window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  return motionQuery?.matches === true;
}

export function createBoardView(
  host,
  {
    layout,
    puzzle,
    sprites,
    onGrab,
    onDrop,
    onZoom,
    predict,
    predictTray,
    onLockedPress,
    frameLook = {},
    holdMs = 0,
    renewMs = 0,
    onHoldRenew,
  },
) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pz-canvas';
  host.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const layer = document.createElement('canvas'); // everything but the dragged cluster and the preview
  const layerCtx = layer.getContext('2d');
  const hitCtx = document.createElement('canvas').getContext('2d');
  // predict / predictTray are optional: without them there is no drag preview or tug.
  const frameLayer = createFrameLayer(layout, puzzle, frameLook);
  const sidePaths = new Map(); // `${index}:${side}` -> Path2D

  const dpr = () => Math.min(MAX_DPR, window.devicePixelRatio || 1);
  let view = { viewW: 1, viewH: 1 };
  let cam = { scale: 1, x: 0, y: 0 };
  let userMoved = false;
  let camTween = null; // { from, to, t0 }

  const display = new Map(); // piece index -> { x, y, fromX, fromY, toX, toY, t0, dur }
  const startAt = new Map(); // piece index -> where it should appear (from the tray)
  let order = []; // [{ id, indices, locked }]: locked ones first, then by z
  let lastClusters = [];
  let locked = null; // Set of locked piece indexes (null until the first clusters arrive)
  let flashes = []; // [{ indices, t0, dur, kind: 'snap' | 'lock', calm }]
  let shakes = []; // [{ id, t0, calm }] refused locked clusters (wiggle, or outline when calm)
  let drag = null; // { id, pointerId, indices, offX, offY, x, y, startX, startY, from }
  let hover = null; // a tray piece over the board: { index, x, y }
  let magnet = null; // { key, preview, pull } for the current drag or hover
  let gesture = null; // { kind: 'pan' | 'pinch', ... }
  let lockedPress = null; // { cluster, pointerId, from, fired }
  let holders = new Map(); // cluster id -> { color, name }: held by a friend
  let holdTimer = 0;
  const pointers = new Map();
  let frame = 0;
  let layerValid = false;
  let spritesPending = false;
  let wheelTimer = 0;

  // ---------- drawing ----------

  function requestRender() {
    if (!frame) frame = requestAnimationFrame(renderFrame);
  }

  function invalidate() {
    layerValid = false;
    requestRender();
  }

  function setWorldTransform(c) {
    const k = dpr();
    c.setTransform(k * cam.scale, 0, 0, k * cam.scale, k * cam.x, k * cam.y);
  }

  function drawBoard(c) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = COLORS.outside;
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    setWorldTransform(c);
    c.fillStyle = COLORS.board;
    c.fillRect(0, 0, layout.boardWidth, layout.boardHeight);
    c.strokeStyle = COLORS.boardEdge;
    c.lineWidth = 1 / cam.scale;
    c.strokeRect(0, 0, layout.boardWidth, layout.boardHeight);

    const r = visibleBoardRect(cam, view, layout);
    const dot = 2.4 / cam.scale;
    c.beginPath();
    for (let x = Math.ceil(r.x0 / DOT_SPACING) * DOT_SPACING; x <= r.x1; x += DOT_SPACING) {
      for (let y = Math.ceil(r.y0 / DOT_SPACING) * DOT_SPACING; y <= r.y1; y += DOT_SPACING) {
        c.rect(x - dot / 2, y - dot / 2, dot, dot);
      }
    }
    c.fillStyle = COLORS.dot;
    c.fill();
    frameLayer.draw(c, cam, dpr());
  }

  // mode: 'resting' | 'lifted' | 'locked' (flat in the frame: no shadow).
  function drawCluster(c, indices, mode, dx = 0, dy = 0) {
    if (mode !== 'locked') {
      const lifted = mode === 'lifted';
      c.globalAlpha = lifted ? 0.3 : 0.2;
      const ox = (lifted ? 4 : 1.5) + dx;
      const oy = (lifted ? 9 : 2.5) + dy;
      for (const i of indices) {
        const p = display.get(i);
        const box = sprites.boxes[i];
        c.drawImage(sprites.get(i).shadow, p.x + box.x + ox, p.y + box.y + oy, box.w, box.h);
      }
      c.globalAlpha = 1;
    }
    for (const i of indices) {
      const p = display.get(i);
      const box = sprites.boxes[i];
      c.drawImage(sprites.get(i).body, p.x + box.x + dx, p.y + box.y + dy, box.w, box.h);
    }
  }

  function strokeAt(c, path, x, y) {
    c.save();
    c.translate(x, y);
    c.stroke(path);
    c.restore();
  }

  function sidePath(index, side) {
    const key = `${index}:${side}`;
    let path = sidePaths.get(key);
    if (!path) {
      path = new Path2D();
      const segments = sideSegments(puzzle.pieces[index], side, layout.cols, layout.rows);
      path.moveTo(segments[0][0][0], segments[0][0][1]);
      for (const [, c1, c2, p] of segments) path.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p[0], p[1]);
      sidePaths.set(key, path);
    }
    return path;
  }

  // Where the pieces will land: a tinted outline under the dragged piece.
  function drawLanding(c, preview) {
    c.lineJoin = 'round';
    c.fillStyle = COLORS.placeFill;
    c.strokeStyle = preview.frameLock ? COLORS.placeLine : COLORS.ghostLine;
    c.lineWidth = (preview.frameLock ? 2.5 : 2) / cam.scale;
    for (const cell of preview.moving) {
      const i = pieceOfCell(cell, layout.cols);
      c.save();
      c.translate(preview.x, preview.y);
      c.fill(sprites.paths[i]);
      c.stroke(sprites.paths[i]);
      c.restore();
    }
  }

  // The edges that will touch, drawn over the dragged piece so they show through.
  function drawTouchingEdges(c, preview) {
    c.lineJoin = 'round';
    c.lineCap = 'round';
    for (const [width, alpha] of [
      [7, 0.22],
      [3, 0.95],
    ]) {
      c.strokeStyle = `rgba(${COLORS.edge}, ${alpha})`;
      c.lineWidth = width / cam.scale;
      for (const { cell, side } of preview.edges) {
        strokeAt(c, sidePath(pieceOfCell(cell, layout.cols), side), preview.x, preview.y);
      }
    }
  }

  function drawFlashes(c, now) {
    flashes = flashes.filter((f) => now - f.t0 < f.dur);
    for (const f of flashes) {
      if (now < f.t0) continue; // starts once the snap slide is nearly done
      const lock = f.kind === 'lock';
      const t = (now - f.t0) / f.dur;
      const grow = f.calm ? 0 : t;
      for (const i of f.indices) {
        const p = display.get(i);
        if (!p) continue;
        c.save();
        c.translate(p.x, p.y);
        if (lock) {
          // A short warm glint over the piece, then a golden ring that fades.
          c.globalAlpha = (f.calm ? 0.25 : 0.55) * (1 - t) ** 2;
          c.fillStyle = COLORS.flash;
          c.fill(sprites.paths[i]);
          c.globalAlpha = 1 - t;
          c.strokeStyle = `rgb(${COLORS.lockGlow})`;
          c.lineWidth = (3 + 7 * grow) / cam.scale;
        } else {
          c.globalAlpha = 1 - t;
          c.strokeStyle = COLORS.flash;
          c.lineWidth = (2 + 4 * grow) / cam.scale;
        }
        c.stroke(sprites.paths[i]);
        c.restore();
      }
    }
    c.globalAlpha = 1;
  }

  function shakeOffset(id, now) {
    const s = shakes.find((k) => k.id === id);
    if (!s || s.calm) return 0;
    const t = (now - s.t0) / SHAKE_MS;
    return (Math.sin(t * Math.PI * 6) * SHAKE_PX * (1 - t)) / cam.scale;
  }

  function stepTweens(now) {
    let moving = false;
    for (const p of display.values()) {
      if (p.t0 === undefined) continue;
      const t = Math.min(1, (now - p.t0) / p.dur);
      const e = easeOut(t);
      p.x = p.fromX + (p.toX - p.fromX) * e;
      p.y = p.fromY + (p.toY - p.fromY) * e;
      if (t >= 1) p.t0 = undefined;
      else moving = true;
    }
    return moving;
  }

  function stepCamera(now) {
    if (!camTween) return false;
    const t = Math.min(1, (now - camTween.t0) / REVEAL_MS);
    const e = easeOut(t);
    const { from, to } = camTween;
    cam = { scale: to.scale, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    if (t >= 1) camTween = null;
    return true;
  }

  function renderStatic(c, skipId, now) {
    drawBoard(c);
    setWorldTransform(c);
    for (const cluster of order) {
      if (cluster.id === skipId) continue;
      const dx = shakes.length ? shakeOffset(cluster.id, now) : 0;
      drawCluster(c, cluster.indices, cluster.locked ? 'locked' : 'resting', dx, 0);
      if (shakes.some((s) => s.calm && s.id === cluster.id)) outlineCluster(c, cluster.indices);
      const holder = holders.get(cluster.id);
      if (holder) outlineCluster(c, cluster.indices, holder.color, 3);
    }
    // Name tags last, so no piece covers them.
    for (const cluster of order) {
      const holder = holders.get(cluster.id);
      if (holder && cluster.id !== skipId) drawNameTag(c, cluster.indices, holder);
    }
  }

  // A small pill in the friend's colour above the middle of the cluster's top row.
  function drawNameTag(c, indices, { color, name }) {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    for (const i of indices) {
      const p = display.get(i);
      const piece = puzzle.pieces[i];
      left = Math.min(left, p.x + piece.x0);
      right = Math.max(right, p.x + piece.x0 + layout.pw);
      top = Math.min(top, p.y + sprites.boxes[i].y); // includes the tabs
    }
    const k = 1 / cam.scale;
    c.save();
    c.font = `700 ${12 * k}px Pretendard, system-ui, sans-serif`;
    const textW = c.measureText(name).width;
    const padX = 8 * k;
    const h = 20 * k;
    const w = textW + padX * 2;
    const cx = (left + right) / 2;
    const y = top - h - 4 * k;
    c.fillStyle = color;
    c.beginPath();
    c.roundRect(cx - w / 2, y, w, h, h / 2);
    c.fill();
    c.fillStyle = '#fff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(name, cx, y + h / 2 + 0.5 * k);
    c.restore();
  }

  function outlineCluster(c, indices, color = COLORS.refused, width = 2.5) {
    c.lineJoin = 'round';
    c.strokeStyle = color;
    c.lineWidth = width / cam.scale;
    for (const i of indices) {
      const p = display.get(i);
      strokeAt(c, sprites.paths[i], p.x, p.y);
    }
  }

  function renderFrame(now) {
    frame = 0;
    const moving = stepTweens(now);
    const panning = stepCamera(now);
    shakes = shakes.filter((s) => now - s.t0 < SHAKE_MS);
    const overlay = drag !== null || hover !== null;
    const skipId = drag ? drag.id : null;
    if (overlay && !moving && !panning && flashes.length === 0 && shakes.length === 0) {
      if (!layerValid) {
        layer.width = canvas.width;
        layer.height = canvas.height;
        renderStatic(layerCtx, skipId, now);
        layerValid = true;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
    } else {
      layerValid = false;
      renderStatic(ctx, skipId, now);
    }
    setWorldTransform(ctx);
    if (magnet?.preview) drawLanding(ctx, magnet.preview);
    if (drag) drawCluster(ctx, drag.indices, 'lifted', magnet?.pull.x ?? 0, magnet?.pull.y ?? 0);
    if (magnet?.preview) drawTouchingEdges(ctx, magnet.preview);
    drawFlashes(ctx, now);
    if (moving || panning || flashes.length || shakes.length) requestRender();
    else if (spritesPending && !gesture && !drag) refreshSprites();
  }

  // Re-render sprites for the current zoom a few at a time between frames.
  function refreshSprites() {
    spritesPending = sprites.step(performance.now() + SPRITE_STEP_MS);
    invalidate();
  }

  function zoomSettled() {
    frameLayer.setScale(cam.scale, dpr());
    spritesPending = sprites.setPixelScale(cam.scale * dpr()) || spritesPending;
    requestRender();
  }

  // ---------- magnet preview ----------

  // Recomputed only when the dragged position changes (or the clusters do).
  function updateMagnet(key, compute, from) {
    if (magnet?.key === key) return magnet;
    const preview = compute() ?? null;
    magnet = { key, preview, pull: pullOffset(preview, from) };
    return magnet;
  }

  function dragMagnet() {
    if (!drag || !predict) return;
    updateMagnet(`d:${drag.id}:${drag.x}:${drag.y}`, () => predict(drag.id, drag.x, drag.y), drag);
  }

  // A tray piece dragged over the board (picture origin at x, y), or null when it left.
  // Returns the lean toward its snap place in CSS pixels, for the dragged ghost.
  function hoverFromTray(index, x, y) {
    if (index === null || !predictTray) {
      if (hover) {
        hover = null;
        magnet = null;
        requestRender();
      }
      return { x: 0, y: 0 };
    }
    hover = { index, x, y };
    const m = updateMagnet(`t:${index}:${x}:${y}`, () => predictTray(index, x, y), hover);
    requestRender();
    return { x: m.pull.x * cam.scale, y: m.pull.y * cam.scale };
  }

  // ---------- state from the store ----------

  function tween(p, x, y, dur) {
    if (calm()) {
      p.x = p.toX = x;
      p.y = p.toY = y;
      p.t0 = undefined;
      return;
    }
    if (p.toX === x && p.toY === y) return;
    p.fromX = p.x;
    p.fromY = p.y;
    p.toX = x;
    p.toY = y;
    p.t0 = performance.now();
    p.dur = dur;
  }

  function pushFlash(indices, kind) {
    const quiet = calm();
    const dur = quiet ? CALM_FLASH_MS : kind === 'lock' ? LOCK_FLASH_MS : FLASH_MS;
    // Starts once the snap slide is nearly done (no slide when calm).
    const t0 = performance.now() + (quiet ? 0 : SNAP_MS * 0.6);
    flashes.push({ indices, t0, dur, kind, calm: quiet });
  }

  function trackLocks(clusters) {
    const now = new Set();
    for (const c of clusters) {
      if (c.locked) for (const cell of c.pieces) now.add(pieceOfCell(cell, layout.cols));
    }
    if (locked) {
      const fresh = [...now].filter((i) => !locked.has(i));
      if (fresh.length) pushFlash(fresh, 'lock');
    }
    locked = now;
  }

  function setClusters(clusters) {
    lastClusters = clusters;
    trackLocks(clusters);
    const seen = new Set();
    const all = clusters.map((c) => {
      const indices = c.pieces.map((cell) => pieceOfCell(cell, layout.cols));
      for (const i of indices) {
        seen.add(i);
        let p = display.get(i);
        if (!p) {
          const start = startAt.get(i) ?? { x: c.x, y: c.y };
          startAt.delete(i);
          p = { x: start.x, y: start.y, toX: start.x, toY: start.y };
          display.set(i, p);
        }
        if (!(drag && drag.indices.includes(i))) tween(p, c.x, c.y, SLIDE_MS);
      }
      return { id: c.id, indices, locked: c.locked === true };
    });
    order = [...all.filter((c) => c.locked), ...all.filter((c) => !c.locked)];
    for (const i of [...display.keys()]) if (!seen.has(i)) display.delete(i);
    if (drag) {
      const current = order.find((c) => c.indices.includes(drag.indices[0]));
      if (current) {
        drag.id = current.id;
        drag.indices = current.indices;
      }
    }
    magnet = null; // other pieces moved: predict again
    dragMagnet();
    if (hover) hoverFromTray(hover.index, hover.x, hover.y);
    invalidate();
  }

  // A piece coming from the tray appears where it was released (leaning like its
  // ghost did), then slides.
  function expectFromTray(index, x, y) {
    const lean = hover?.index === index && magnet ? magnet.pull : { x: 0, y: 0 };
    startAt.set(index, { x: x + lean.x, y: y + lean.y });
  }

  // Predicted resting place right after a drop (confirmed later by the store).
  // A lock gets its own flash when the store reports it (trackLocks).
  function settle(indices, x, y, { snapped, locks = false }) {
    for (const i of indices) {
      const p = display.get(i);
      if (p) tween(p, x, y, snapped ? SNAP_MS : SLIDE_MS);
    }
    if (snapped && !locks) pushFlash(indices, 'snap');
    invalidate();
  }

  // Pans (same zoom) so the board rectangle is on screen, e.g. a piece put beside it.
  function reveal(rect) {
    const target = revealCamera(cam, view, layout, rect, REVEAL_PAD_PX);
    if (target.x === cam.x && target.y === cam.y) return;
    userMoved = true;
    if (calm()) {
      camTween = null;
      cam = target;
    } else {
      camTween = { from: { ...cam }, to: target, t0: performance.now() };
    }
    invalidate();
  }

  // ---------- hit testing ----------

  // Topmost loose cluster under the point (exact outline first, then near its cell);
  // locked clusters only when no loose one is there.
  function hitTest(bx, by) {
    const slop = HIT_SLOP_PX / cam.scale;
    for (const wantLocked of [false, true]) {
      let loose = null;
      for (let k = order.length - 1; k >= 0; k--) {
        if (order[k].locked !== wantLocked) continue;
        for (const i of order[k].indices) {
          const p = display.get(i);
          const piece = puzzle.pieces[i];
          const lx = bx - p.x;
          const ly = by - p.y;
          const box = sprites.boxes[i];
          if (lx < box.x || ly < box.y || lx > box.x + box.w || ly > box.y + box.h) continue;
          if (hitCtx.isPointInPath(sprites.paths[i], lx, ly)) return order[k];
          const nearCell =
            lx >= piece.x0 - slop &&
            lx <= piece.x0 + layout.pw + slop &&
            ly >= piece.y0 - slop &&
            ly <= piece.y0 + layout.ph + slop;
          if (!loose && nearCell) loose = order[k];
        }
      }
      if (loose) return loose;
    }
    return null;
  }

  // ---------- pointer input ----------

  const local = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  function setCamera(next) {
    camTween = null;
    cam = clampCamera(next, view, layout);
    userMoved = true;
    invalidate();
  }

  function startPan(pointerId) {
    const pt = pointers.get(pointerId);
    gesture = { kind: 'pan', pointerId, start: { ...cam }, from: pt };
  }

  function endGesture() {
    gesture = null;
    zoomSettled();
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    gesture = {
      kind: 'pinch',
      start: { ...cam },
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  function beginDrag(cluster, e, pt) {
    const b = screenToBoard(cam, pt.x, pt.y);
    const p = display.get(cluster.indices[0]);
    drag = {
      id: cluster.id,
      pointerId: e.pointerId,
      indices: cluster.indices,
      offX: b.x - p.x,
      offY: b.y - p.y,
      x: p.x,
      y: p.y,
      startX: p.toX, // where the store has it
      startY: p.toY,
      from: pt,
      movedAt: performance.now(),
      renewedAt: performance.now(),
    };
    startHoldTimer();
    magnet = null;
    const grabbedId = cluster.id;
    layerValid = false;
    requestRender();
    const refused = () => {
      if (drag && drag.id === grabbedId) cancelDrag();
    };
    // A failed grab is reported by the screen; here the drag just stops.
    Promise.resolve(onGrab(grabbedId)).then((ok) => ok || refused(), refused);
  }

  function moveDrag(pt) {
    const b = screenToBoard(cam, pt.x, pt.y);
    const x = b.x - drag.offX;
    const y = b.y - drag.offY;
    if (x !== drag.x || y !== drag.y) drag.movedAt = performance.now();
    drag.x = x;
    drag.y = y;
    for (const i of drag.indices) {
      const p = display.get(i);
      p.x = p.toX = drag.x;
      p.y = p.toY = drag.y;
      p.t0 = undefined;
    }
    dragMagnet();
    requestRender();
  }

  // The pieces start their slide from where they were drawn (leaning toward the snap).
  function bakePull() {
    const pull = magnet?.pull;
    if (!pull || (pull.x === 0 && pull.y === 0)) return;
    for (const i of drag.indices) {
      const p = display.get(i);
      p.x += pull.x;
      p.y += pull.y;
    }
  }

  // Held still too long: let go where it is. Still moving: keep the hold on the server.
  function startHoldTimer() {
    if (!holdMs || holdTimer) return;
    holdTimer = setInterval(() => {
      if (!drag) return stopHoldTimer();
      const now = performance.now();
      if (now - drag.movedAt >= holdMs) endDrag();
      else if (renewMs && drag.movedAt > drag.renewedAt && now - drag.renewedAt >= renewMs) {
        drag.renewedAt = now;
        onHoldRenew?.(drag.id);
      }
    }, 250);
  }

  function stopHoldTimer() {
    clearInterval(holdTimer);
    holdTimer = 0;
  }

  function endDrag() {
    const { id, x, y } = drag;
    stopHoldTimer();
    bakePull();
    drag = null;
    magnet = null;
    invalidate();
    onDrop(id, x, y);
  }

  // Grab refused: the pieces slide back to where the store has them.
  function cancelDrag() {
    stopHoldTimer();
    drag = null;
    magnet = null;
    setClusters(lastClusters);
  }

  // Trying to pick up a locked piece: it wiggles in place and the screen says why.
  function refuseLocked() {
    if (!lockedPress || lockedPress.fired) return;
    lockedPress.fired = true;
    const { id } = lockedPress.cluster;
    shakes = shakes.filter((s) => s.id !== id);
    shakes.push({ id, t0: performance.now(), calm: calm() });
    invalidate();
    onLockedPress?.();
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture?.(e.pointerId);
    camTween = null;
    const pt = local(e);
    pointers.set(e.pointerId, pt);
    if (pointers.size === 1) {
      const b = screenToBoard(cam, pt.x, pt.y);
      const hit = hitTest(b.x, b.y);
      const mouse = e.pointerType === 'mouse';
      if (hit && !hit.locked) beginDrag(hit, e, pt);
      else {
        if (hit) lockedPress = { cluster: hit, pointerId: e.pointerId, from: pt, mouse, fired: false };
        if (mouse) startPan(e.pointerId);
      }
    } else {
      lockedPress = null; // two fingers on a locked piece: just zoom
      if (pointers.size === 2 && drag && pointers.has(drag.pointerId)) {
        const moved = pointers.get(drag.pointerId);
        if (Math.hypot(moved.x - drag.from.x, moved.y - drag.from.y) < PINCH_TAKEOVER_PX) {
          putBackDrag();
          startPinch();
        }
      } else if (pointers.size === 2 && !drag) {
        startPinch();
      }
    }
  }

  // Two fingers mean zoom: the piece goes back and is released where it was.
  function putBackDrag() {
    const { id, startX, startY } = drag;
    stopHoldTimer();
    drag = null;
    magnet = null;
    invalidate();
    onDrop(id, startX, startY);
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const pt = local(e);
    pointers.set(e.pointerId, pt);
    if (lockedPress?.pointerId === e.pointerId && !lockedPress.mouse && pointers.size === 1) {
      if (Math.hypot(pt.x - lockedPress.from.x, pt.y - lockedPress.from.y) >= LOCKED_DRAG_PX) refuseLocked();
    }
    if (drag && drag.pointerId === e.pointerId) {
      moveDrag(pt);
    } else if (gesture?.kind === 'pan' && gesture.pointerId === e.pointerId) {
      setCamera({ ...gesture.start, x: gesture.start.x + pt.x - gesture.from.x, y: gesture.start.y + pt.y - gesture.from.y });
    } else if (gesture?.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const limit = (scale) => clampScale(scale, view, layout);
      setCamera(pinchCamera(gesture.start, gesture.mid, gesture.dist, mid, Math.hypot(a.x - b.x, a.y - b.y), limit));
      onZoom?.();
    }
  }

  function onPointerEnd(e) {
    if (!pointers.has(e.pointerId)) return;
    const pt = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (lockedPress?.pointerId === e.pointerId) {
      // A tap (or a click without panning) on a locked piece.
      if (Math.hypot(pt.x - lockedPress.from.x, pt.y - lockedPress.from.y) < LOCKED_DRAG_PX) refuseLocked();
      lockedPress = null;
    }
    if (drag && drag.pointerId === e.pointerId) {
      endDrag();
      return;
    }
    // The finger left after a pinch does nothing until a second one comes back.
    if (gesture?.kind === 'pinch' && pointers.size < 2) endGesture();
    else if (pointers.size === 0 && gesture) endGesture();
  }

  function onWheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.viewH : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
    const pt = local(e);
    setCamera(zoomAt(cam, clampScale(cam.scale * factor, view, layout), pt.x, pt.y));
    onZoom?.();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(zoomSettled, 160);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ---------- size ----------

  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;
    const centre = screenToBoard(cam, view.viewW / 2, view.viewH / 2);
    view = { viewW: w, viewH: h };
    canvas.width = Math.round(w * dpr());
    canvas.height = Math.round(h * dpr());
    camTween = null;
    if (!userMoved) {
      cam = fitCamera(view, layout);
    } else {
      cam = clampCamera({ scale: cam.scale, x: w / 2 - centre.x * cam.scale, y: h / 2 - centre.y * cam.scale }, view, layout);
    }
    zoomSettled();
    // Changing canvas.width clears it: draw now, not next frame, to avoid a blank flash.
    cancelAnimationFrame(frame);
    layerValid = false;
    renderFrame(performance.now());
  }

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  // Clusters friends hold: Map of cluster id -> { color, name }.
  function setHolders(next) {
    const same = next.size === holders.size && [...next].every(([id, h]) => holders.get(id)?.color === h.color && holders.get(id)?.name === h.name);
    holders = next;
    if (!same) invalidate();
  }

  // The page is hidden or the connection dropped: let go of the dragged piece where it is.
  function releaseDrag() {
    if (drag) endDrag();
    pointers.clear();
    gesture = null;
    lockedPress = null;
  }

  return {
    canvas,
    setClusters,
    setHolders,
    releaseDrag,
    get dragging() {
      return drag ? drag.id : null;
    },
    // Friends' holds drawn now (for tests): [{ id, color, name }].
    get holders() {
      return [...holders].map(([id, holder]) => ({ id, ...holder }));
    },
    expectFromTray,
    settle,
    reveal,
    hoverFromTray,
    get camera() {
      return { ...(camTween ? camTween.to : cam) };
    },
    // Running slides and view moves (for tests: none when reduced motion is asked for).
    get animating() {
      return { slides: [...display.values()].filter((p) => p.t0 !== undefined).length, panning: camTween !== null };
    },
    // What the drag preview shows right now (for tests and the screen): null or a snapPreview().
    get preview() {
      return magnet?.preview ?? null;
    },
    clientToBoard(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      return screenToBoard(cam, cx - rect.left, cy - rect.top);
    },
    boardToClient(bx, by) {
      const rect = canvas.getBoundingClientRect();
      const p = boardToScreen(camTween ? camTween.to : cam, bx, by);
      return { x: p.x + rect.left, y: p.y + rect.top };
    },
    containsClient(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
    },
    // The screen in board units, past the board edges too.
    viewRect() {
      return viewBoardRect(cam, view);
    },
    destroy() {
      observer.disconnect();
      stopHoldTimer();
      cancelAnimationFrame(frame);
      clearTimeout(wheelTimer);
      canvas.remove();
    },
  };
}
