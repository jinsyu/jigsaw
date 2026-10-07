// 모둠 편성 panel of the lobby (mockup teacher-lobby): students without a group, one box per
// group, 무작위로 나누기 and 시작하기.
// Moving a student, three ways:
// - drag a name onto a box (mouse, touch, pen: drag.js);
// - tap or press a name to pick it, then press 여기에 놓기 in the box it should go to
//   (keyboard and switch users, and teachers who find dragging awkward on a whiteboard);
// - Escape drops the pick.
import { memberColor } from '../student/colors.js';
import { withParticle } from '../student/names.js';
import { enableChipDrag } from './drag.js';
import { h, icon, nodes, pieceIcon } from './dom.js';
import { UNNAMED, groupColumns, startBlocker } from './roster.js';

export function createGroupingPanel({ groups, onAssign, onRandomize, onStart }) {
  let roster = null;
  let status = 'waiting';
  let selected = null; // member id picked for moving
  let busy = ''; // 'randomize' | 'start' | ''
  let pendingRender = false;
  let focusAfter = null; // { member } | { slot } to focus after the next render

  const sub = h('p', { class: 'sub' });
  const randomize = h('button', { class: 'btn t-randomize', type: 'button' }, icon('shuffle'), h('span', {}, '무작위로 나누기'));
  const start = h('button', { class: 'btn pri t-start', type: 'button', 'aria-describedby': 't-start-hint' }, '시작하기');
  const playing = h('span', { class: 'pill ok t-playing' }, h('i', { class: 'dot' }), '퍼즐 하는 중');
  const actions = h('div', { class: 't-grouping-actions' }, randomize, start, playing);
  const startHint = h('p', { class: 't-start-hint', id: 't-start-hint' });
  const error = h('p', { class: 't-error', role: 'alert' });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const help = h(
    'p',
    { class: 'sr-only', id: 't-chip-help' },
    '끌어서 모둠 칸에 놓거나, 눌러서 고른 뒤 옮길 칸의 여기에 놓기를 누르세요.',
  );
  const poolCount = h('span', {});
  const poolList = h('ul', { class: 't-chips', 'aria-label': '아직 모둠이 없는 학생' });
  const poolEmpty = h('p', { class: 't-empty-line' });
  const pool = h(
    'section',
    { class: 'card t-pool', 'data-drop': 'pool', 'aria-labelledby': 't-pool-title' },
    h('h3', { id: 't-pool-title' }, '아직 모둠이 없는 학생', poolCount),
    poolEmpty,
    poolList,
  );
  const boxes = new Map();
  const groupList = h(
    'ul',
    { class: 't-groups', style: `--group-cols:${groupColumns(groups.length)}` },
    groups.map((g) => {
      const count = h('span', {});
      const list = h('ul', { class: 't-chips', 'aria-label': `${g.number}모둠 학생` });
      const box = h(
        'li',
        { class: 'card t-group', 'data-drop': String(g.id), 'aria-labelledby': `t-group-${g.id}` },
        h('h3', { id: `t-group-${g.id}` }, `${g.number}모둠`, count),
        list,
      );
      boxes.set(g.id, { number: g.number, count, list });
      return box;
    }),
  );
  const element = h(
    'section',
    { class: 't-grouping', 'aria-labelledby': 't-grouping-title', 'data-slot': 'grouping' },
    h('div', { class: 't-grouping-head' }, h('div', {}, h('h2', { id: 't-grouping-title' }, '모둠 편성'), sub), actions),
    startHint,
    error,
    announcer,
    help,
    pool,
    groupList,
  );

  const drag = enableChipDrag(element, {
    onStart: () => {
      error.textContent = '';
      setSelected(null, { silent: true });
    },
    onDrop: (memberId, drop) => move(memberId, drop === 'pool' ? null : Number(drop)),
    onEnd: () => {
      if (pendingRender) render();
    },
  });

  function studentById(id) {
    if (!roster) return null;
    return roster.pool.find((s) => s.id === id) ?? roster.groups.flatMap((g) => g.students).find((s) => s.id === id) ?? null;
  }

  const nameOf = (student) => student?.label ?? UNNAMED;
  const placeName = (groupId) => (groupId === null ? '모둠 없음' : `${boxes.get(groupId)?.number}모둠`);

  function announce(text) {
    announcer.textContent = '';
    // A fresh text node so screen readers read the same sentence twice in a row.
    requestAnimationFrame(() => (announcer.textContent = text));
  }

  function move(memberId, groupId) {
    const student = studentById(memberId);
    if (!student || student.groupId === groupId) return;
    setSelected(null, { silent: true });
    focusAfter = { member: memberId };
    announce(`${nameOf(student)}, ${withParticle(placeName(groupId), '으로', '로')} 옮겼어요.`);
    onAssign(memberId, groupId);
  }

  function setSelected(id, { silent = false } = {}) {
    selected = id;
    if (!silent && id !== null) {
      announce(`${withParticle(nameOf(studentById(id)), '을', '를')} 골랐어요. 옮길 칸의 여기에 놓기를 누르세요. 그만두려면 Esc 키를 누르세요.`);
    }
    render();
  }

  // Chips and slots are kept per member / per box and updated in place, so a live update
  // (server events, answers) never swaps the element under a tap, a drag start or
  // a key press, and focus stays where it was.
  const chipItems = new Map(); // member id -> { li, button, color, name, online }
  const slotItems = new Map(); // 'pool' | group id -> { li, button }

  function chip(student) {
    let item = chipItems.get(student.id);
    if (!item) {
      const button = h('button', {
        class: 'chip t-chip',
        type: 'button',
        'data-member': String(student.id),
        'aria-describedby': 't-chip-help',
      });
      button.addEventListener('click', () => setSelected(selected === student.id ? null : student.id));
      item = { li: h('li', {}, button), button, color: undefined, name: undefined, online: undefined };
      chipItems.set(student.id, item);
    }
    const { button } = item;
    const color = memberColor(student.groupId === null ? null : student.color);
    const name = nameOf(student);
    button.className = `chip t-chip${student.online ? '' : ' off'}${student.name ? '' : ' is-unnamed'}${selected === student.id ? ' is-selected' : ''}`;
    button.setAttribute('aria-pressed', selected === student.id ? 'true' : 'false');
    if (item.color !== color || item.name !== name || item.online !== student.online) {
      button.replaceChildren(
        ...nodes(pieceIcon(color), h('span', { class: 't-chip-name' }, name), student.online ? null : h('em', {}, '나감')),
      );
      Object.assign(item, { color, name, online: student.online });
    }
    return item.li;
  }

  // Drop slot: a hint while nothing is picked, a button once a student is picked.
  function slot(groupId) {
    const picked = selected === null ? null : studentById(selected);
    const armed = Boolean(picked) && picked.groupId !== groupId;
    const isPool = groupId === null;
    if (isPool && !armed) return null; // the pool needs no hint, only a target while moving
    if (picked && !armed) return null; // the picked student's own box
    const key = isPool ? 'pool' : groupId;
    let item = slotItems.get(key);
    if (!item) {
      const button = h('button', { class: 't-slot', type: 'button', 'data-slot': isPool ? 'pool' : String(groupId) });
      button.addEventListener('click', () => {
        const current = selected === null ? null : studentById(selected);
        if (current && current.groupId !== groupId) move(current.id, groupId);
        else announce('먼저 옮길 학생 이름을 누르거나 끌어 주세요.');
      });
      item = { li: h('li', { class: 't-slot-item' }, button), button };
      slotItems.set(key, item);
    }
    const { button } = item;
    button.className = `t-slot${armed ? ' is-armed' : ''}`;
    button.textContent = armed ? (isPool ? '여기로 빼기' : '여기에 놓기') : '여기로 끌어 놓기';
    if (armed) {
      button.removeAttribute('tabindex');
      button.removeAttribute('aria-hidden');
      button.setAttribute(
        'aria-label',
        `${withParticle(nameOf(picked), '을', '를')} ${isPool ? '모둠에서 빼기' : `${placeName(groupId)}에 놓기`}`,
      );
    } else {
      button.setAttribute('tabindex', '-1');
      button.setAttribute('aria-hidden', 'true');
      button.removeAttribute('aria-label');
    }
    return item.li;
  }

  // Puts `nodes` into `list` in order, moving only the nodes that are out of place.
  function syncList(list, nodes) {
    nodes.forEach((node, i) => {
      if (list.children[i] !== node) list.insertBefore(node, list.children[i] ?? null);
    });
    while (list.children.length > nodes.length) list.lastElementChild.remove();
  }

  function rememberFocus() {
    const active = document.activeElement;
    if (!element.contains(active)) return null;
    if (active.dataset.member) return { member: active.dataset.member };
    if (active.dataset.slot) return { slot: active.dataset.slot };
    return null;
  }

  function restoreFocus(target) {
    if (!target) return;
    const node = target.member
      ? element.querySelector(`[data-member="${target.member}"]`)
      : element.querySelector(`[data-slot="${target.slot}"]`) ?? element.querySelector(`[data-member="${selected}"]`);
    node?.focus({ preventScroll: false });
  }

  function render() {
    if (!roster) return;
    if (drag.isDragging()) {
      pendingRender = true; // keep the dragged chip in the page until it is dropped
      return;
    }
    pendingRender = false;
    if (selected !== null && !studentById(selected)) selected = null;
    const focus = focusAfter ?? rememberFocus();
    focusAfter = null;
    const isPlaying = status === 'playing';

    sub.textContent = isPlaying
      ? '늦게 온 학생도 모둠 칸으로 끌어 넣으면 그 모둠 퍼즐에 바로 함께해요.'
      : '이름을 모둠 칸으로 끌어 놓거나, 무작위로 나눠요.';
    randomize.hidden = isPlaying;
    start.hidden = isPlaying;
    playing.hidden = !isPlaying;
    const blocker = isPlaying ? '' : startBlocker(roster);
    randomize.disabled = Boolean(busy) || roster.total === 0;
    start.disabled = Boolean(busy) || Boolean(blocker);
    randomize.lastChild.textContent = busy === 'randomize' ? '나누는 중…' : '무작위로 나누기';
    start.textContent = busy === 'start' ? '시작하는 중…' : '시작하기';
    startHint.textContent = blocker;
    element.classList.toggle('has-pick', selected !== null);

    poolCount.textContent = `${roster.pool.length}명`;
    poolEmpty.textContent =
      roster.total === 0
        ? '학생이 코드를 넣고 들어오면 여기에 이름이 나타나요.'
        : roster.pool.length === 0
          ? '모든 학생이 모둠에 들어갔어요.'
          : '';
    poolEmpty.hidden = !poolEmpty.textContent;
    const listed = new Set();
    const items = (students, groupId) => {
      students.forEach((st) => listed.add(st.id));
      return [...students.map(chip), slot(groupId)].filter(Boolean);
    };
    syncList(poolList, items(roster.pool, null));
    for (const group of roster.groups) {
      const box = boxes.get(group.id);
      if (!box) continue;
      box.count.textContent = `${group.students.length}명`;
      syncList(box.list, items(group.students, group.id));
    }
    for (const id of chipItems.keys()) if (!listed.has(id)) chipItems.delete(id);
    restoreFocus(focus); // no-op when the element still has focus
  }

  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selected !== null) {
      const id = selected;
      setSelected(null, { silent: true });
      announce('고르기를 그만뒀어요.');
      element.querySelector(`[data-member="${id}"]`)?.focus();
    }
  });
  randomize.addEventListener('click', () => onRandomize());
  start.addEventListener('click', () => onStart());

  return {
    element,
    update(next, { status: nextStatus = status } = {}) {
      roster = next;
      status = nextStatus;
      render();
    },
    setBusy(next) {
      busy = next;
      render();
    },
    showError(text) {
      error.textContent = text;
    },
    clearError() {
      error.textContent = '';
    },
    announce,
    isDragging: () => drag.isDragging(),
    destroy() {
      drag.destroy();
    },
  };
}
