// "My pieces" tray. Tiles are buttons: drag one out onto the board, or tap /
// press Enter to put it on a free spot. Swiping along the tray scrolls it
// (touch-action pan-x / pan-y in CSS), swiping toward the board pulls a piece.

const DRAG_THRESHOLD_PX = 6;
const TILE_CSS_PX = 112;

// onDragMove(index, clientX, clientY) may return { x, y }: a CSS pixel lean for the ghost
// (toward where the piece would snap). onDragEnd() runs after the drop is handled.
export function createTrayView(list, { renderTile, makeGhost, canDropAt, onDropAt, onTap, ghostHost, onDragMove, onDragEnd }) {
  const tiles = new Map(); // piece index -> button
  let press = null; // { index, tile, pointerId, x, y, dragging, ghost }
  let suppressClick = false;

  function createTile(index) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile pz-tile';
    tile.dataset.piece = String(index);
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    renderTile(index, canvas, TILE_CSS_PX);
    tile.append(canvas);
    tile.addEventListener('pointerdown', onPointerDown);
    tile.addEventListener('pointermove', onPointerMove);
    tile.addEventListener('pointerup', onPointerUp);
    tile.addEventListener('pointercancel', onPointerCancel);
    tile.addEventListener('click', onClick);
    return tile;
  }

  function setPieces(indexes) {
    const keep = new Set(indexes);
    for (const [index, tile] of tiles) {
      if (!keep.has(index)) {
        tile.remove();
        tiles.delete(index);
      }
    }
    indexes.forEach((index, k) => {
      let tile = tiles.get(index);
      if (!tile) {
        tile = createTile(index);
        tiles.set(index, tile);
      }
      tile.setAttribute('aria-label', `조각 ${k + 1} 꺼내기`);
      if (list.children[k] !== tile) list.insertBefore(tile, list.children[k] ?? null);
    });
  }

  function placeGhost(ghost, x, y, lean = { x: 0, y: 0 }) {
    ghost.el.style.transform = `translate3d(${x + lean.x - ghost.anchorX}px, ${y + lean.y - ghost.anchorY}px, 0)`;
  }

  function startDrag(e) {
    const tile = press.tile;
    tile.setPointerCapture?.(e.pointerId);
    const ghost = makeGhost(press.index);
    ghost.el.classList.add('pz-ghost');
    // Grow from the tile size to the board size so the piece "lifts" out of the tray.
    const from = tile.getBoundingClientRect().width / Math.max(ghost.width, ghost.height);
    ghost.inner.style.transform = `scale(${Math.min(1.4, from).toFixed(3)})`;
    ghostHost.append(ghost.el);
    placeGhost(ghost, e.clientX, e.clientY);
    requestAnimationFrame(() => {
      ghost.inner.style.transform = 'scale(1)';
    });
    tile.classList.add('is-lifted');
    press.dragging = true;
    press.ghost = ghost;
  }

  function finish(dropped, e) {
    const current = press;
    press = null;
    if (!current?.dragging) return;
    current.ghost.el.remove();
    current.tile.classList.remove('is-lifted');
    suppressClick = true;
    // The click (if any) arrives right after pointerup; clear the flag after it.
    setTimeout(() => {
      suppressClick = false;
    }, 0);
    if (dropped && canDropAt(e.clientX, e.clientY)) onDropAt(current.index, e.clientX, e.clientY);
    onDragEnd?.();
  }

  function onPointerDown(e) {
    if (press || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const tile = e.currentTarget;
    press = { index: Number(tile.dataset.piece), tile, pointerId: e.pointerId, x: e.clientX, y: e.clientY, dragging: false };
    if (e.pointerType === 'mouse') e.preventDefault(); // no text selection while dragging
  }

  function onPointerMove(e) {
    if (!press || e.pointerId !== press.pointerId) return;
    if (!press.dragging) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return;
      startDrag(e);
    }
    placeGhost(press.ghost, e.clientX, e.clientY, onDragMove?.(press.index, e.clientX, e.clientY) ?? undefined);
  }

  function onPointerUp(e) {
    if (press && e.pointerId === press.pointerId) {
      if (press.dragging) finish(true, e);
      else press = null;
    }
  }

  function onPointerCancel(e) {
    if (press && e.pointerId === press.pointerId) {
      if (press.dragging) finish(false, e);
      else press = null;
    }
  }

  function onClick(e) {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      return;
    }
    onTap(Number(e.currentTarget.dataset.piece));
  }

  return { setPieces };
}
