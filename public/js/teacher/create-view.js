// 새 수업 만들기 (mockup teacher-create): pick a picture, a piece count, a group count and
// the help settings, then '수업 열기' asks the rt server for the class and opens the lobby with
// the code and QR.
import { createSession } from './data.js';
import { h, icon, setTitle } from './dom.js';
import {
  GROUP_COUNT,
  HINT_OPTIONS,
  PIECE_COUNT_INITIAL,
  clampGroupCount,
  createErrorMessage,
  demoUrl,
  onOffLabel,
  piecesPerStudentNote,
} from './format.js';
import { faceWarning, pictureCard, uploadedDetail } from './picture-cards.js';
import { uploadPanel } from './upload-panel.js';
import { loadBuiltins, loadMyImages } from './pictures.js';
import { previewOutline } from './preview.js';
import { sessionPath } from './routes.js';
import { PIECE_COUNTS } from '../puzzle/geometry.js';
import { DEFAULT_HINTS } from '../store/puzzle-store.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function renderCreate(main, ctx) {
  ctx.setBar('nav', { active: 'new' });
  setTitle('새 수업 만들기');

  const state = { picture: null, pieceCount: PIECE_COUNT_INITIAL, hints: { ...DEFAULT_HINTS }, busy: false };
  let alive = true;

  // ----- 1. picture tabs -----
  const tabs = [
    { id: 'builtin', label: '내장 그림' },
    { id: 'mine', label: '내 그림' },
    { id: 'upload', label: '사진 올리기' },
  ];
  const tabButtons = {};
  const panels = {};
  const tabList = h('div', { class: 't-tabs', role: 'tablist', 'aria-label': '그림 고르는 곳' });
  for (const tab of tabs) {
    const count = h('em', { class: 't-tab-count' });
    tabButtons[tab.id] = h(
      'button',
      {
        class: 't-tab',
        type: 'button',
        role: 'tab',
        id: `t-tab-${tab.id}`,
        'aria-controls': `t-panel-${tab.id}`,
        onclick: () => selectTab(tab.id),
      },
      tab.label,
      count,
    );
    panels[tab.id] = h('div', {
      class: 't-panel',
      role: 'tabpanel',
      id: `t-panel-${tab.id}`,
      'aria-labelledby': `t-tab-${tab.id}`,
      tabindex: '0',
    });
    tabList.append(tabButtons[tab.id]);
  }
  tabList.addEventListener('keydown', (event) => {
    const order = tabs.map((t) => t.id);
    const current = order.indexOf(document.activeElement?.id?.replace('t-tab-', ''));
    if (current < 0) return;
    const next = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: order.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const id = order[(next + order.length) % order.length];
    selectTab(id);
    tabButtons[id].focus();
  });

  function selectTab(id) {
    for (const tab of tabs) {
      const on = tab.id === id;
      tabButtons[tab.id].setAttribute('aria-selected', String(on));
      tabButtons[tab.id].tabIndex = on ? 0 : -1;
      panels[tab.id].hidden = !on;
    }
  }

  const pictureCardSection = h(
    'section',
    { class: 'card t-card', 'aria-labelledby': 't-step-picture' },
    h('h2', { class: 't-step', id: 't-step-picture' }, h('i', { 'aria-hidden': 'true' }, '1'), '그림 고르기'),
    tabList,
    ...Object.values(panels),
  );

  // ----- side: preview, 2. piece count, 3. group count, open -----
  const previewTitle = h('h2', { class: 't-preview-title' });
  const previewNote = h('small', {});
  const preview = h('div', { class: 't-preview' });
  // Where the chosen picture comes from (outside pictures must show their source line).
  const credit = h('p', { class: 't-credit', id: 't-credit' });
  // Try the puzzle alone first (built-in pictures only), in a new tab so the choices stay.
  const tryLink = h(
    'a',
    { class: 'btn t-try', target: '_blank', rel: 'noopener', hidden: true },
    icon('puzzle', 18),
    '혼자 맞춰 보기',
    h('span', { class: 'sr-only' }, ' (새 탭)'),
  );

  const pieceNote = h('p', { class: 't-note', id: 't-piece-note' });
  const pieceSeg = h(
    'div',
    { class: 'seg t-seg' },
    PIECE_COUNTS.map((n) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'piece-count',
          value: n,
          checked: n === state.pieceCount,
          'aria-describedby': 't-piece-note',
          onchange: () => {
            state.pieceCount = n;
            updatePieces();
          },
        }),
        h('span', {}, String(n)),
      ),
    ),
  );

  const groupInput = h('input', {
    id: 't-group-count',
    type: 'number',
    inputmode: 'numeric',
    min: GROUP_COUNT.min,
    max: GROUP_COUNT.max,
    value: GROUP_COUNT.initial,
    'aria-describedby': 't-group-note',
  });
  const minus = h('button', { type: 'button', 'aria-label': '모둠 하나 줄이기' }, icon('minus', 22));
  const plus = h('button', { type: 'button', 'aria-label': '모둠 하나 늘리기' }, icon('plus', 22));
  const setGroups = (value) => {
    const n = clampGroupCount(value);
    groupInput.value = String(n);
    minus.disabled = n <= GROUP_COUNT.min;
    plus.disabled = n >= GROUP_COUNT.max;
  };
  minus.addEventListener('click', () => setGroups(Number(groupInput.value) - 1));
  plus.addEventListener('click', () => setGroups(Number(groupInput.value) + 1));
  groupInput.addEventListener('change', () => setGroups(groupInput.value));
  setGroups(GROUP_COUNT.initial);

  // 4. help settings (spec rule 10) with a small picture of the frame students will see.
  const frameMini = h('div', { class: 't-frame-mini' });
  const hintSwitches = HINT_OPTIONS.map((option) => {
    const id = `t-hint-${option.key}`;
    return h(
      'li',
      {},
      h(
        'label',
        { class: 't-switch', for: id },
        h(
          'span',
          { class: 't-switch-text' },
          h('b', { id: `${id}-label` }, option.label),
          h('small', { id: `${id}-help` }, option.help, ' ', h('em', {}, `(기본: ${onOffLabel(DEFAULT_HINTS[option.key])})`)),
        ),
        h('input', {
          id,
          type: 'checkbox',
          role: 'switch',
          class: 't-switch-input',
          name: option.key,
          checked: state.hints[option.key],
          'aria-labelledby': `${id}-label`,
          'aria-describedby': `${id}-help`,
          onchange: (event) => {
            state.hints[option.key] = event.target.checked;
            updateFrameMini();
          },
        }),
      ),
    );
  });

  const error = h('p', { class: 't-error', role: 'alert' });
  const openButton = h('button', { class: 'btn pri big t-open', type: 'button', onclick: open }, '수업 열기');

  // The settings scroll inside the panel on wide screens; '수업 열기' stays in view at the
  // bottom of the panel (wide) or of the screen (narrow).
  const hintsField = h(
    'fieldset',
    { class: 't-field t-hints', id: 't-hints', 'aria-describedby': 't-hints-note' },
    h('legend', { class: 't-step' }, h('i', { 'aria-hidden': 'true' }, '4'), '도움 설정'),
    h('p', { class: 't-note t-hints-note', id: 't-hints-note' }, '학년과 목적에 맞게 골라요. 이 수업의 모든 모둠에 똑같이 적용돼요.'),
    h('figure', { class: 't-frame-look' }, frameMini, h('figcaption', {}, '학생 판 가운데 틀은 이렇게 보여요')),
    h('ul', { class: 't-switches' }, hintSwitches),
  );
  // Wide screens: the settings scroll inside the panel. While more is below, the bottom
  // fades and a small button points to the help settings.
  const moreButton = h(
    'button',
    { class: 't-side-more', type: 'button', hidden: true, 'aria-controls': 't-hints', onclick: () => scrollToHints() },
    '아래에 도움 설정이 있어요',
    icon('down', 16),
  );
  const sideBody = h(
    'div',
    { class: 't-side-body' },
    h('div', {}, h('div', { class: 't-lbl' }, previewTitle, previewNote), h('div', { class: 't-preview-wrap' }, preview, tryLink), credit),
    h(
      'fieldset',
      { class: 't-field' },
      h('legend', { class: 't-step' }, h('i', { 'aria-hidden': 'true' }, '2'), '조각 수'),
      pieceSeg,
      pieceNote,
    ),
    h(
      'div',
      { class: 't-field' },
      h('label', { class: 't-step', for: 't-group-count' }, h('i', { 'aria-hidden': 'true' }, '3'), '모둠 수'),
      h('div', { class: 't-stepper' }, minus, groupInput, plus),
      h('p', { class: 't-note', id: 't-group-note' }, '모둠마다 따로 퍼즐이 열려요. 모둠당 4~6명이 알맞아요.'),
    ),
    hintsField,
  );
  const side = h(
    'aside',
    { class: 'card t-side', 'aria-label': '수업 설정' },
    // The button floats over the faded bottom of the list, so the list keeps its height.
    h('div', { class: 't-side-scroll' }, sideBody, moreButton),
    h('div', { class: 't-side-foot' }, error, openButton),
  );

  function updateMore() {
    const more = sideBody.scrollHeight - sideBody.clientHeight - sideBody.scrollTop > 4;
    sideBody.classList.toggle('has-more', more);
    moreButton.hidden = !more;
  }
  function scrollToHints() {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const top = hintsField.offsetTop - sideBody.offsetTop - 8;
    sideBody.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
    hintsField.querySelector('input')?.focus({ preventScroll: true });
  }
  sideBody.addEventListener('scroll', updateMore, { passive: true });
  const sideObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateMore) : null;
  sideObserver?.observe(sideBody);
  sideObserver?.observe(hintsField);

  main.append(
    h(
      'div',
      { class: 't-wrap t-create' },
      h(
        'div',
        { class: 't-create-main' },
        h(
          'div',
          { class: 't-head' },
          h(
            'div',
            {},
            h('h1', { tabindex: '-1' }, '새 수업 만들기'),
            h('p', { class: 'sub' }, '그림, 조각 수, 모둠 수만 고르면 바로 수업 코드가 나와요.'),
          ),
        ),
        pictureCardSection,
      ),
      side,
    ),
  );

  // ----- picture choice and preview -----
  function choosePicture(picture) {
    state.picture = picture;
    error.textContent = '';
    updatePreview();
  }

  function updatePieces() {
    pieceNote.textContent = piecesPerStudentNote(state.pieceCount);
    updatePreview();
  }

  function updatePreview() {
    previewNote.textContent = `${state.pieceCount}조각 미리보기`;
    updateFrameMini();
    if (!state.picture) {
      credit.replaceChildren();
      previewTitle.textContent = '그림을 골라 주세요';
      preview.replaceChildren(h('span', { class: 't-preview-empty' }, icon('image', 32)));
      return;
    }
    previewTitle.textContent = state.picture.title;
    preview.replaceChildren(previewSvg(state.picture, state.pieceCount));
    credit.replaceChildren(...creditLine(state.picture));
    updateMore(); // the preview and source line change the list height
  }

  function updateTryLink() {
    const url = state.picture ? demoUrl({ builtinKey: state.picture.builtinKey, pieceCount: state.pieceCount, hints: state.hints }) : null;
    tryLink.hidden = !url;
    if (url) tryLink.href = url;
    else tryLink.removeAttribute('href');
  }

  function updateFrameMini() {
    updateTryLink();
    frameMini.dataset.outline = String(state.hints.outline);
    frameMini.dataset.underlay = String(state.hints.underlay);
    if (!state.picture) {
      frameMini.replaceChildren();
      return;
    }
    frameMini.replaceChildren(frameSvg(state.picture, state.pieceCount, state.hints));
  }

  function choiceRadio(value, picture, checked) {
    return { name: 'picture', value, checked, onchange: () => choosePicture(picture) };
  }

  // Built-in pictures
  function showBuiltins() {
    const panel = panels.builtin;
    panel.replaceChildren(gridSkeleton());
    panel.setAttribute('aria-busy', 'true');
    loadBuiltins()
      .then((builtins) => {
        if (!alive) return;
        tabButtons.builtin.querySelector('.t-tab-count').textContent = String(builtins.length);
        const pictures = builtins.map((b) => ({
          value: `builtin:${b.key}`,
          title: b.title,
          category: b.category,
          level: b.level,
          detail: cardDetail(b),
          thumb: b.thumb,
          picture: {
            builtinKey: b.key,
            aspect: b.width / b.height,
            title: b.title,
            width: b.width,
            height: b.height,
            src: b.src,
            credit: b.credit,
            sourceUrl: b.source?.url ?? null,
            licenseName: b.license?.name ?? null,
            licenseUrl: b.license?.url ?? null,
          },
        }));
        // The first picture of the first chip is chosen at the start.
        const firstKind = orderedCategories(pictures)[0];
        const first = pictures.find((p) => p.category === firstKind);
        const cards = pictures.map((p, i) => ({
          category: p.category,
          search: pictureSearchText(builtins[i]),
          node: pictureCard({
            src: p.thumb,
            title: p.title,
            detail: p.detail,
            level: p.level,
            radio: choiceRadio(p.value, p.picture, p === first && !state.picture),
          }),
        }));
        const grid = h('div', { class: 't-pics', role: 'radiogroup', 'aria-label': '내장 그림', id: 't-builtin-grid' }, cards.map((c) => c.node));
        panel.replaceChildren(...pictureFilter(cards, grid));
        if (!state.picture && first) choosePicture(first.picture);
      })
      .catch((err) => {
        console.error(err);
        if (!alive) return;
        panel.replaceChildren(retryBox('그림 목록을 불러오지 못했어요.', showBuiltins));
      })
      .finally(() => panel.removeAttribute('aria-busy'));
  }

  // The teacher's own pictures. `selectId`: an image just uploaded, chosen right away.
  function showMine(selectId = null) {
    const panel = panels.mine;
    panel.replaceChildren(gridSkeleton(2));
    panel.setAttribute('aria-busy', 'true');
    loadMyImages(ctx.api)
      .then((images) => {
        if (!alive) return;
        tabButtons.mine.querySelector('.t-tab-count').textContent = String(images.length);
        const note = h('p', { class: 't-panel-note' }, '나만 볼 수 있어요 · 지울 때까지 보관');
        const toUpload = h(
          'button',
          { class: 't-upload t-upload-tile', type: 'button', onclick: () => (selectTab('upload'), tabButtons.upload.focus()) },
          icon('upload', 28),
          h('b', {}, '사진 올리기'),
          h('span', {}, '크기를 자동으로 줄이고', h('br'), '촬영 위치 정보를 지워요'),
        );
        if (!images.length) {
          panel.replaceChildren(
            note,
            h(
              'div',
              { class: 't-empty t-empty-inline' },
              h('h3', {}, '아직 올린 그림이 없어요'),
              h('p', { class: 'sub' }, '우리 반 사진이나 그림을 올리면 여기에 모여요.'),
            ),
            h('div', { class: 't-pics' }, toUpload),
            faceWarning(),
          );
          return;
        }
        panel.replaceChildren(
          note,
          h(
            'div',
            { class: 't-pics', role: 'radiogroup', 'aria-label': '내 그림' },
            images.map((image) => {
              const picture = { imageId: image.id, title: '내 그림', width: image.width, height: image.height, src: image.url };
              if (image.id === selectId) choosePicture(picture);
              return pictureCard({
                src: image.url,
                title: '내 그림',
                detail: uploadedDetail(image),
                radio: choiceRadio(`image:${image.id}`, picture, image.id === selectId),
              });
            }),
            toUpload,
          ),
          faceWarning(),
        );
        if (selectId) {
          selectTab('mine');
          panel.querySelector(`input[value="image:${selectId}"]`)?.focus();
        }
      })
      .catch((err) => {
        console.error(err);
        if (!alive) return;
        panel.replaceChildren(retryBox('내 그림을 불러오지 못했어요.', () => showMine(selectId)));
      })
      .finally(() => panel.removeAttribute('aria-busy'));
  }

  panels.upload.append(uploadPanel({ api: ctx.api, onUploaded: (image) => showMine(image.id) }));

  async function open() {
    if (state.busy) return;
    if (!state.picture) {
      error.textContent = '그림을 먼저 골라 주세요.';
      return;
    }
    state.busy = true;
    error.textContent = '';
    openButton.disabled = true;
    openButton.textContent = '수업을 여는 중…';
    side.setAttribute('aria-busy', 'true');
    try {
      const created = await createSession(ctx.api, {
        picture: state.picture,
        pieceCount: state.pieceCount,
        groupCount: clampGroupCount(groupInput.value),
        hints: state.hints,
      });
      if (alive) ctx.navigate(sessionPath(created.sessionId));
    } catch (err) {
      console.error(err);
      if (!alive) return;
      error.textContent = createErrorMessage(err);
      openButton.disabled = false;
      openButton.textContent = '수업 열기';
      side.removeAttribute('aria-busy');
      state.busy = false;
    }
  }

  selectTab('builtin');
  updatePieces();
  showBuiltins();
  showMine();
  return () => {
    alive = false;
    sideObserver?.disconnect();
  };
}

// Kinds of built-in pictures, in chip order (photos and picture-book art first: the youngest
// classes like them best). Kinds not listed here come after, in index order.
const CATEGORY_ORDER = ['사진', '삽화', '명화', '우리 그림'];

// The kinds present in `items` ({ category }), in chip order.
export function orderedCategories(items) {
  const present = [...new Set(items.map((item) => item.category))];
  return [...CATEGORY_ORDER.filter((c) => present.includes(c)), ...present.filter((c) => !CATEGORY_ORDER.includes(c))];
}

// Card note: what a photo shows (동물, 탈것, ...); the maker and year of a painting or an
// illustration (the theme when neither is known).
export function cardDetail(builtin) {
  if (builtin.category === '사진' && builtin.topic) return builtin.topic;
  const year = builtin.year === '연도 미상' ? null : builtin.year;
  return [builtin.source?.author, year].filter(Boolean).join(', ') || builtin.topic || builtin.category;
}

// Theme shortcuts under the search field: what is searched (`word`) and the button text.
const THEME_SHORTCUTS = [
  { word: '동물', label: '동물' },
  { word: '탈것', label: '탈것' },
  { word: '바다', label: '바다' },
  { word: '우주', label: '우주' },
  { word: '꽃', label: '꽃·식물' },
  { word: '상상', label: '이야기' },
  { word: '명소', label: '명소' },
  { word: '쉬움', label: '쉬운 그림' },
];

// Words a built-in picture can be found by: title, theme, kind, level, maker, year.
export function pictureSearchText(builtin) {
  return normalizeSearch([builtin.title, builtin.topic, builtin.category, builtin.level, builtin.source?.author, builtin.year].filter(Boolean).join(' '));
}
// Lower case, no spaces: '반 고흐' and '반고흐' find the same pictures.
export function normalizeSearch(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, '');
}

// Above the built-in pictures: a search field and category chips (a group of toggle buttons,
// one pressed; arrow keys move between them; the row scrolls sideways on narrow screens).
// While the field has words, the chips let go and every picture that matches shows.
function pictureFilter(cards, grid) {
  const categories = orderedCategories(cards);
  let current = categories[0];
  const buttons = categories.map((category) =>
    h(
      'button',
      { class: 't-chip-filter', type: 'button', 'aria-controls': grid.id, onclick: () => show(category) },
      category,
      h('em', {}, String(cards.filter((card) => card.category === category).length)),
    ),
  );
  const group = h('div', { class: 't-chips-filter', role: 'group', 'aria-label': '내장 그림 분류' }, buttons);
  group.addEventListener('keydown', (event) => {
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const i = (next + buttons.length) % buttons.length;
    show(categories[i]);
    buttons[i].focus();
  });
  const status = h('p', { class: 't-search-status', role: 'status' });
  const field = h('input', {
    type: 'search',
    class: 't-search-input',
    placeholder: '그림 찾기 (예: 바다, 호랑이, 고흐)',
    'aria-label': '내장 그림 찾기',
    'aria-controls': grid.id,
    enterkeyhint: 'search',
    autocomplete: 'off',
    oninput: () => filter(),
    onkeydown: (event) => {
      if (event.key === 'Escape' && field.value) {
        event.preventDefault();
        field.value = '';
        filter();
      }
    },
  });
  const search = h('label', { class: 't-search' }, icon('search', 18), field);
  // One tap fills the field with a theme (the themes pictures have, children's favourites first).
  const themes = THEME_SHORTCUTS.filter((t) => cards.some((card) => card.search.includes(normalizeSearch(t.word))));
  const shortcuts = h(
    'div',
    { class: 't-themes', role: 'group', 'aria-label': '주제로 찾기' },
    themes.map((t) =>
      h(
        'button',
        {
          type: 'button',
          class: 't-theme',
          'aria-controls': grid.id,
          onclick: () => {
            field.value = t.word;
            filter();
          },
        },
        t.label,
      ),
    ),
  );

  function reveal(card, visible) {
    card.node.hidden = !visible;
    // A lazy image that was hidden waits for layout before loading: ask for it now.
    const img = card.node.querySelector('img');
    if (visible && img?.loading === 'lazy') img.loading = 'eager';
  }
  function show(category) {
    current = category;
    if (field.value) field.value = '';
    for (const button of shortcuts.children) button.setAttribute('aria-pressed', 'false');
    status.textContent = '';
    categories.forEach((c, i) => {
      buttons[i].setAttribute('aria-pressed', String(c === category));
      buttons[i].tabIndex = c === category ? 0 : -1;
    });
    for (const card of cards) reveal(card, card.category === category);
    grid.setAttribute('aria-label', `내장 그림: ${category}`);
    buttons[categories.indexOf(category)].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  function filter() {
    const query = normalizeSearch(field.value);
    themes.forEach((t, i) => shortcuts.children[i].setAttribute('aria-pressed', String(query === normalizeSearch(t.word))));
    if (!query) {
      show(current);
      return;
    }
    categories.forEach((c, i) => {
      buttons[i].setAttribute('aria-pressed', 'false');
      buttons[i].tabIndex = c === current ? 0 : -1;
    });
    let found = 0;
    for (const card of cards) {
      const visible = card.search.includes(query);
      reveal(card, visible);
      if (visible) found += 1;
    }
    grid.setAttribute('aria-label', `내장 그림: '${field.value.trim()}' 찾은 결과`);
    status.textContent = found ? `${found}장 찾았어요` : '찾는 그림이 없어요. 다른 말로 찾아보거나 분류를 눌러 보세요.';
  }
  show(current);
  return [h('div', { class: 't-pic-filter' }, search, shortcuts, group), status, grid];
}

// Source line under the preview: outside pictures name the work, maker, holder and licence,
// with links to the original and the licence.
function creditLine(picture) {
  if (!picture.credit) return [];
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  return [
    picture.credit,
    ' ',
    h(
      'span',
      { class: 't-credit-links' },
      picture.sourceUrl ? link(picture.sourceUrl, '원본') : null,
      picture.sourceUrl && picture.licenseUrl ? ' · ' : null,
      picture.licenseUrl ? link(picture.licenseUrl, '라이선스') : null,
    ),
  ];
}

function previewSvg(picture, pieceCount) {
  const outline = previewOutline(pieceCount, picture.width, picture.height);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${outline.width} ${outline.height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${picture.title}을 ${pieceCount}조각(가로 ${outline.cols}, 세로 ${outline.rows})으로 나눈 모양`);
  const image = document.createElementNS(SVG_NS, 'image');
  image.setAttribute('href', picture.src);
  image.setAttribute('width', outline.width);
  image.setAttribute('height', outline.height);
  image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.append(image);
  const d = outline.paths.join('');
  // A soft dark line under a white one keeps the cuts visible on light and dark pictures.
  for (const [stroke, width] of [
    ['rgba(30, 25, 20, .35)', 3],
    ['rgba(255, 255, 255, .95)', 1.5],
  ]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', width);
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
  }
  return svg;
}

// The empty frame as the student board draws it (play/frame.js): piece outlines and the
// faint picture follow the help settings.
function frameSvg(picture, pieceCount, hints) {
  const outline = previewOutline(pieceCount, picture.width, picture.height);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${outline.width} ${outline.height}`);
  svg.setAttribute('role', 'img');
  const parts = [hints.outline ? '조각 윤곽선 있음' : '바깥 테두리만', hints.underlay ? '흐린 밑그림 있음' : '밑그림 없음'];
  svg.setAttribute('aria-label', `학생 판의 틀: ${parts.join(', ')}`);
  const add = (tag, attrs) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  };
  add('rect', { width: outline.width, height: outline.height, fill: '#FBF8F1' });
  if (hints.underlay) {
    add('image', {
      href: picture.src,
      width: outline.width,
      height: outline.height,
      preserveAspectRatio: 'xMidYMid slice',
      opacity: '0.2',
    });
  }
  const line = { fill: 'none', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
  if (hints.outline) {
    add('path', { ...line, class: 't-frame-seams', d: outline.paths.join(''), stroke: 'rgba(96, 78, 52, .36)', 'stroke-width': 1 });
  }
  add('rect', { ...line, width: outline.width, height: outline.height, stroke: 'rgba(96, 78, 52, .45)', 'stroke-width': 2 });
  return svg;
}

function gridSkeleton(count = 4) {
  return h(
    'div',
    { class: 't-pics', 'aria-hidden': 'true' },
    Array.from({ length: count }, () => h('span', { class: 't-pic t-skel-pic' }, h('span', { class: 't-skel' }))),
  );
}

function retryBox(text, retry) {
  return h(
    'div',
    { class: 't-empty t-empty-inline', role: 'alert' },
    h('h3', {}, text),
    h('p', { class: 'sub' }, '인터넷 연결을 확인하고 다시 시도해 주세요.'),
    h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh'), '다시 시도'),
  );
}
