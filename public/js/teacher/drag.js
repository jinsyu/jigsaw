// Dragging name chips onto group boxes with pointer events (mouse, touch and pen alike).
// While the pointer moves, only a floating copy moves (transform, once per frame); the
// roster changes once, on drop. Chips set touch-action: none so a finger drags instead of
// scrolling; near the top or bottom edge the page scrolls by itself.
const START_DISTANCE = 6;
const EDGE = 72;
const MAX_SCROLL_STEP = 16;
const CLICK_AFTER_DROP_MS = 400;

/**
 * @param {HTMLElement} root  contains chips ([data-member]) and drop boxes ([data-drop])
 * @param {{ onDrop(memberId: number, drop: string): void, onStart?(memberId: number): void, onEnd?(): void }} handlers
 */
export function enableChipDrag(root, { onDrop, onStart, onEnd }) {
  let drag = null;
  // The chip just dropped and when, to swallow the click a mouse sends after the drag.
  let dropped = { chip: null, at: -Infinity };

  function targetAt(x, y) {
    const box = document.elementFromPoint(x, y)?.closest('[data-drop]');
    return box && root.contains(box) ? box : null;
  }

  function begin() {
    const rect = drag.chip.getBoundingClientRect();
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;
    const ghost = drag.chip.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('t-chip-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    // Inside a modal dialog (모둠 편성 on 모둠 한눈에 보기) the ghost must be in the dialog:
    // the dialog sits in the top layer, above anything appended to the body.
    (root.closest('dialog[open]') ?? document.body).append(ghost);
    drag.ghost = ghost;
    drag.active = true;
    drag.chip.classList.add('is-lifted');
    root.classList.add('is-dragging');
    onStart?.(drag.id);
    drag.frame = requestAnimationFrame(frame);
  }

  function frame() {
    if (!drag?.active) return;
    const { ghost, x, y } = drag;
    ghost.style.transform = `translate3d(${x - drag.offsetX}px, ${y - drag.offsetY}px, 0) rotate(-4deg)`;
    const target = targetAt(x, y);
    if (target !== drag.target) {
      drag.target?.classList.remove('is-over');
      target?.classList.add('is-over');
      drag.target = target;
    }
    if (y < EDGE) window.scrollBy(0, -Math.ceil(((EDGE - y) / EDGE) * MAX_SCROLL_STEP));
    else if (y > innerHeight - EDGE) window.scrollBy(0, Math.ceil(((y - (innerHeight - EDGE)) / EDGE) * MAX_SCROLL_STEP));
    drag.frame = requestAnimationFrame(frame);
  }

  function finish(drop) {
    if (!drag) return;
    const { active, chip, ghost, target, id, frame: raf } = drag;
    cancelAnimationFrame(raf);
    ghost?.remove();
    target?.classList.remove('is-over');
    chip.classList.remove('is-lifted');
    root.classList.remove('is-dragging');
    drag = null;
    if (active) {
      dropped = { chip, at: performance.now() };
      if (drop && target) onDrop(id, target.dataset.drop);
      onEnd?.();
    }
  }

  root.addEventListener('pointerdown', (event) => {
    const chip = event.target.closest('[data-member]');
    if (!chip || !root.contains(chip) || !event.isPrimary || event.button !== 0 || drag) return;
    drag = {
      chip,
      id: chip.dataset.member, // member ids are the rt server's UUIDs
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      ghost: null,
      target: null,
      frame: 0,
    };
    chip.setPointerCapture?.(event.pointerId);
  });
  root.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= START_DISTANCE) begin();
  });
  root.addEventListener('pointerup', (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.active) drag.target = targetAt(drag.x, drag.y);
      finish(true);
    }
  });
  root.addEventListener('pointercancel', (event) => {
    if (drag && event.pointerId === drag.pointerId) finish(false);
  });
  root.addEventListener('lostpointercapture', (event) => {
    if (drag && event.pointerId === drag.pointerId && drag.active) finish(false);
  });
  root.addEventListener(
    'click',
    (event) => {
      // The click a mouse sends right after a drag (on the dragged chip) must not also pick
      // it. Keyboard clicks (detail 0) and clicks elsewhere always pass. A time window instead
      // of a timer: timers in a background tab can run seconds late.
      const afterDrop =
        dropped.chip?.contains(event.target) && performance.now() - dropped.at < CLICK_AFTER_DROP_MS;
      if (afterDrop && event.detail !== 0) {
        dropped = { chip: null, at: -Infinity };
        event.stopPropagation();
        event.preventDefault();
      }
    },
    true,
  );
  function onKey(event) {
    if (event.key === 'Escape' && drag?.active) finish(false);
  }
  window.addEventListener('keydown', onKey);

  return {
    isDragging: () => Boolean(drag?.active),
    destroy() {
      finish(false);
      window.removeEventListener('keydown', onKey);
    },
  };
}
