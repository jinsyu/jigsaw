// Board canvas: draws the frame and clusters from piece sprites and turns pointer
// input into piece drags (one finger or the mouse on a piece), pans and zooms
// (two fingers; the mouse drags empty board and uses the wheel). One finger on
// empty board does nothing, so the board never slides away under a child's hand.
// It knows nothing about the store: the screen passes clusters in and gets
// onGrab / onDrop calls out.
import { pieceOfCell } from '../store/puzzle-store.js';
import {
  clampCamera,
  clampScale,
  fitCamera,
  pinchCamera,
  screenToBoard,
  boardToScreen,
  viewBoardRect,
  visibleBoardRect,
  zoomAt,
} from './camera.js';
import { createFrameLayer } from './frame.js';

const MAX_DPR = 2;
const SLIDE_MS = 220;
const SNAP_MS = 130;
const FLASH_MS = 420;
const SPRITE_STEP_MS = 6;
const HIT_SLOP_PX = 10;
// A second finger turns a piece drag into a pinch unless the piece already travelled this far.
const PINCH_TAKEOVER_PX = 30;
const DOT_SPACING = 40;
const COLORS = {
  outside: '#E9E2D5',
  board: '#F3EDE2',
  boardEdge: 'rgba(120, 100, 70, 0.22)',
  dot: 'rgba(120, 100, 70, 0.2)',
  flash: 'rgba(255, 255, 255, 0.95)',
};

const easeOut = (t) => 1 - (1 - t) ** 3;

export function createBoardView(host, { layout, puzzle, sprites, onGrab, onDrop, onZoom }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pz-canvas';
  host.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const layer = document.createElement('canvas'); // everything but the dragged cluster
  const layerCtx = layer.getContext('2d');
  const hitCtx = document.createElement('canvas').getContext('2d');
  const frameLayer = createFrameLayer(layout, puzzle);

  const dpr = () => Math.min(MAX_DPR, window.devicePixelRatio || 1);
  let view = { viewW: 1, viewH: 1 };
  let cam = { scale: 1, x: 0, y: 0 };
  let userMoved = false;

  const display = new Map(); // piece index -> { x, y, fromX, fromY, toX, toY, t0, dur }
  const startAt = new Map(); // piece index -> where it should appear (from the tray)
  let order = []; // [{ id, indices }] by z
  let lastClusters = [];
  let flashes = [];
  let drag = null; // { id, pointerId, indices, offX, offY, x, y }
  let gesture = null; // { kind: 'pan' | 'pinch', ... }
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

  function drawCluster(c, indices, lifted) {
    c.globalAlpha = lifted ? 0.3 : 0.2;
    const ox = lifted ? 4 : 1.5;
    const oy = lifted ? 9 : 2.5;
    for (const i of indices) {
      const p = display.get(i);
      const box = sprites.boxes[i];
      c.drawImage(sprites.get(i).shadow, p.x + box.x + ox, p.y + box.y + oy, box.w, box.h);
    }
    c.globalAlpha = 1;
    for (const i of indices) {
      const p = display.get(i);
      const box = sprites.boxes[i];
      c.drawImage(sprites.get(i).body, p.x + box.x, p.y + box.y, box.w, box.h);
    }
  }

  function drawFlashes(c, now) {
    flashes = flashes.filter((f) => now - f.t0 < FLASH_MS);
    for (const f of flashes) {
      if (now < f.t0) continue; // starts once the snap slide is nearly done
      const t = (now - f.t0) / FLASH_MS;
      c.strokeStyle = COLORS.flash;
      c.globalAlpha = 1 - t;
      c.lineWidth = (2 + 4 * t) / cam.scale;
      for (const i of f.indices) {
        const p = display.get(i);
        if (!p) continue;
        c.save();
        c.translate(p.x, p.y);
        c.stroke(sprites.paths[i]);
        c.restore();
      }
    }
    c.globalAlpha = 1;
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

  function renderStatic(c, skipId) {
    drawBoard(c);
    setWorldTransform(c);
    for (const cluster of order) {
      if (cluster.id !== skipId) drawCluster(c, cluster.indices, false);
    }
  }

  function renderFrame(now) {
    frame = 0;
    const moving = stepTweens(now);
    const dragging = drag !== null;
    if (dragging && !moving && flashes.length === 0) {
      if (!layerValid) {
        layer.width = canvas.width;
        layer.height = canvas.height;
        renderStatic(layerCtx, drag.id);
        layerValid = true;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
    } else {
      layerValid = false;
      renderStatic(ctx, dragging ? drag.id : null);
    }
    setWorldTransform(ctx);
    if (dragging) drawCluster(ctx, drag.indices, true);
    drawFlashes(ctx, now);
    if (moving || flashes.length) requestRender();
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

  // ---------- state from the store ----------

  function tween(p, x, y, dur) {
    if (p.toX === x && p.toY === y) return;
    p.fromX = p.x;
    p.fromY = p.y;
    p.toX = x;
    p.toY = y;
    p.t0 = performance.now();
    p.dur = dur;
  }

  function setClusters(clusters) {
    lastClusters = clusters;
    const seen = new Set();
    order = clusters.map((c) => {
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
      return { id: c.id, indices };
    });
    for (const i of [...display.keys()]) if (!seen.has(i)) display.delete(i);
    if (drag) {
      const current = order.find((c) => c.indices.includes(drag.indices[0]));
      if (current) {
        drag.id = current.id;
        drag.indices = current.indices;
      }
    }
    invalidate();
  }

  // A piece coming from the tray appears where it was released, then slides.
  function expectFromTray(index, x, y) {
    startAt.set(index, { x, y });
  }

  // Predicted resting place right after a drop (confirmed later by the store).
  function settle(indices, x, y, { snapped }) {
    for (const i of indices) {
      const p = display.get(i);
      if (p) tween(p, x, y, snapped ? SNAP_MS : SLIDE_MS);
    }
    if (snapped) flashes.push({ indices, t0: performance.now() + SNAP_MS * 0.6 });
    invalidate();
  }

  // ---------- hit testing ----------

  function hitTest(bx, by) {
    const slop = HIT_SLOP_PX / cam.scale;
    let loose = null;
    for (let k = order.length - 1; k >= 0; k--) {
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
    return loose;
  }

  // ---------- pointer input ----------

  const local = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  function setCamera(next) {
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
    };
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
    drag.x = b.x - drag.offX;
    drag.y = b.y - drag.offY;
    for (const i of drag.indices) {
      const p = display.get(i);
      p.x = p.toX = drag.x;
      p.y = p.toY = drag.y;
      p.t0 = undefined;
    }
    requestRender();
  }

  function endDrag() {
    const { id, x, y } = drag;
    drag = null;
    invalidate();
    onDrop(id, x, y);
  }

  // Grab refused: the pieces slide back to where the store has them.
  function cancelDrag() {
    drag = null;
    setClusters(lastClusters);
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture?.(e.pointerId);
    const pt = local(e);
    pointers.set(e.pointerId, pt);
    if (pointers.size === 1) {
      const b = screenToBoard(cam, pt.x, pt.y);
      const hit = hitTest(b.x, b.y);
      if (hit) beginDrag(hit, e, pt);
      else if (e.pointerType === 'mouse') startPan(e.pointerId);
    } else if (pointers.size === 2 && drag && pointers.has(drag.pointerId)) {
      const moved = pointers.get(drag.pointerId);
      if (Math.hypot(moved.x - drag.from.x, moved.y - drag.from.y) < PINCH_TAKEOVER_PX) {
        putBackDrag();
        startPinch();
      }
    } else if (pointers.size === 2 && !drag) {
      startPinch();
    }
  }

  // Two fingers mean zoom: the piece goes back and is released where it was.
  function putBackDrag() {
    const { id, startX, startY } = drag;
    drag = null;
    invalidate();
    onDrop(id, startX, startY);
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const pt = local(e);
    pointers.set(e.pointerId, pt);
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
    pointers.delete(e.pointerId);
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

  return {
    canvas,
    setClusters,
    expectFromTray,
    settle,
    get camera() {
      return { ...cam };
    },
    clientToBoard(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      return screenToBoard(cam, cx - rect.left, cy - rect.top);
    },
    boardToClient(bx, by) {
      const rect = canvas.getBoundingClientRect();
      const p = boardToScreen(cam, bx, by);
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
      cancelAnimationFrame(frame);
      clearTimeout(wheelTimer);
      canvas.remove();
    },
  };
}
