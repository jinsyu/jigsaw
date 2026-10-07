// Student screens before the puzzle (mockup student-phone #1~#3): code, name, waiting.
// Names are always inserted as text nodes (h() never parses strings as HTML).
import { createCodeField, enhanceCodeField } from '../code-field.js';
import { h, nodes, pieceIcon } from '../teacher/dom.js';
import { memberColor } from './colors.js';
import { NAME_MAX } from './names.js';

const LOCK_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

export function formatCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function setScreen(main, className, title, ...children) {
  document.title = `${title} | 함께 퍼즐`;
  main.className = `page st ${className}`;
  main.removeAttribute('aria-busy');
  main.replaceChildren(...nodes(children));
  window.scrollTo(0, 0);
}

function focusFirst(main, selector) {
  // Focus the heading (or field) so screen readers start at the new screen.
  main.querySelector(selector)?.focus({ preventScroll: true });
}

function brand() {
  return h('p', { class: 'brand' }, h('img', { class: 'ic', src: '/icon.svg', alt: '', width: 26, height: 26 }), '함께 퍼즐');
}

export function renderLoading(main, text) {
  setScreen(main, 'st-center', '들어가는 중', h('p', { class: 'st-loading', role: 'status' }, h('i', { class: 'st-spinner' }), text));
  main.setAttribute('aria-busy', 'true');
}

// Code step on /join (wrong code, or no code in the address). Same look as the home page.
export function renderCodeStep(main, { code = '', error = '', onSubmit }) {
  const field = createCodeField({ value: code });
  const message = h('p', { class: 'st-error', role: 'alert', id: 'st-code-error' }, error);
  const submit = h('button', { class: 'btn pri big', type: 'submit' }, '들어가기');
  const form = h('form', { class: 'code-form', novalidate: true }, field, message, submit);
  setScreen(
    main,
    'home st-code',
    '코드 넣기',
    brand(),
    h('img', { class: 'hero', src: '/images/hero.svg', alt: '', width: 170, height: 170 }),
    h('h1', { tabindex: '-1' }, '선생님이 알려 준', h('br'), '코드를 넣어요'),
    form,
    h('p', { class: 'hint' }, 'QR 코드를 찍으면 코드를 넣지 않아도 돼요'),
    h('div', { class: 'spacer' }),
    h('div', { class: 'home-foot' }, h('a', { class: 'policy-link', href: '/privacy' }, '개인정보 처리방침')),
  );
  const codeField = enhanceCodeField(field);
  if (error) {
    codeField.input.setAttribute('aria-invalid', 'true');
    codeField.input.setAttribute('aria-describedby', 'st-code-error');
    codeField.showError();
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = codeField.input.value;
    if (value.length !== 6) {
      message.textContent = '숫자 6자리를 모두 넣어 주세요.';
      codeField.showError();
      codeField.input.focus();
      return;
    }
    onSubmit(value);
  });
  codeField.input.focus({ preventScroll: true });
}

// Name step (mockup #2). mode 'join' asks before entering, 'rename' fixes a typo later.
export function renderNameStep(main, { code, name = '', mode = 'join', onBack, onSubmit }) {
  const input = h('input', {
    class: 'st-name-input',
    id: 'st-name',
    name: 'name',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    maxlength: String(NAME_MAX),
    required: true,
    'aria-describedby': 'st-name-note st-name-error',
  });
  input.value = name;
  const message = h('p', { class: 'st-error', role: 'alert', id: 'st-name-error' });
  const submit = h('button', { class: 'btn pri big', type: 'submit' }, mode === 'rename' ? '바꾸기' : '다음');
  const back = h(
    'button',
    { class: 'st-back', type: 'button', 'aria-label': mode === 'rename' ? '기다리는 화면으로' : '코드 다시 넣기' },
    h('span', { 'aria-hidden': 'true' }, '‹'),
  );
  back.addEventListener('click', onBack);
  const form = h(
    'form',
    { class: 'st-name-form', novalidate: true },
    h('label', { class: 'sr-only', for: 'st-name' }, '내 이름'),
    input,
    h(
      'p',
      { class: 'st-note', id: 'st-name-note', html: LOCK_ICON },
      h('span', {}, '이름은 저장하지 않아요.', h('br'), '이 기기에만 잠깐 기억하고, 수업이 끝나면 사라져요.'),
    ),
    message,
    h('div', { class: 'spacer' }),
    submit,
  );
  setScreen(
    main,
    'st-name',
    mode === 'rename' ? '이름 고치기' : '이름 넣기',
    h('div', { class: 'st-topnav' }, back, h('span', { class: 'pill' }, `수업 ${formatCode(code)}`)),
    h('h1', { tabindex: '-1' }, mode === 'rename' ? '이름을 고쳐 주세요' : '이름을 알려 주세요'),
    h('p', { class: 'sub' }, '모둠 친구들 화면에 이 이름이 보여요'),
    form,
  );

  function setBusy(busy) {
    submit.disabled = busy;
    input.readOnly = busy;
    const idle = mode === 'rename' ? '바꾸기' : '다음';
    submit.textContent = busy ? (mode === 'rename' ? '바꾸는 중…' : '들어가는 중…') : idle;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    message.textContent = '';
    setBusy(true);
    const error = await onSubmit(input.value);
    if (!main.contains(form)) return; // moved on to another screen
    setBusy(false);
    if (error) {
      message.textContent = error;
      input.focus();
    }
  });
  input.focus({ preventScroll: true });
}

/**
 * Waiting screen (mockup #3), also shown after the start to a student without a group.
 * Returns update(state) to redraw it in place.
 *
 * state: { name, code, status: 'waiting'|'playing', group: { number }|null, myColor,
 *          mates: [{ id, name, color, online, me }], connected: boolean }
 */
export function renderWaiting(main, { onRename }) {
  const banner = h('p', { class: 'st-banner', role: 'status' });
  const pill = h('span', { class: 'pill' });
  const icon = h('div', { class: 'st-bigicon' });
  const title = h('h1', { tabindex: '-1' });
  const sub = h('p', { class: 'sub' });
  const mates = h('ul', { class: 'st-mates', 'aria-label': '우리 모둠' });
  const waitDots = h('div', { class: 'st-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const tips = h(
    'section',
    { class: 'st-tips', 'aria-labelledby': 'st-tips-title' },
    h('h2', { id: 'st-tips-title' }, '이렇게 맞춰요'),
    h(
      'ol',
      {},
      h('li', {}, '내 조각 상자에서 조각을 꺼내요'),
      h('li', {}, '판 위 조각은 누구나 옮길 수 있어요'),
      h('li', {}, '맞는 자리에 놓으면 딱 붙어요'),
    ),
  );
  const codeText = h('span', {});
  const rename = h('button', { class: 'st-link', type: 'button', onclick: onRename }, '이름 고치기');
  const foot = h('p', { class: 'st-foot' }, codeText, rename);
  const live = h('div', { class: 'st-headline', 'aria-live': 'polite' }, title, sub);
  setScreen(main, 'st-wait', '기다리는 중', banner, pill, icon, live, waitDots, mates, tips, h('div', { class: 'spacer' }), foot);
  let firstDraw = true;
  let lastHeadline = '';

  return function update(state) {
    const playing = state.status === 'playing';
    document.title = `${playing ? '퍼즐 시작' : '기다리는 중'} | 함께 퍼즐`;
    banner.textContent = state.connected ? '' : '연결이 끊겼어요. 다시 연결하는 중이에요…';
    pill.className = `pill ${playing ? 'ok' : 'pri'} st-pill`;
    pill.replaceChildren(h('i', { class: 'dot' }), playing ? '퍼즐이 시작됐어요' : '선생님이 시작하기를 기다리는 중');
    icon.replaceChildren(pieceIcon(memberColor(state.group ? state.myColor : null)));
    icon.classList.toggle('is-waiting', !state.group);

    let headline;
    let subline;
    if (!state.group) {
      headline = '선생님이 모둠을 정하고 있어요';
      subline = `${state.name}, 잘 들어왔어요! 조금만 기다려 주세요.`;
    } else if (playing) {
      headline = `${state.group.number}모둠 퍼즐이 시작됐어요!`;
      subline = '퍼즐을 여는 중이에요';
    } else {
      headline = `${state.name}, ${state.group.number}모둠이에요!`;
      subline = '선생님이 시작하면 퍼즐이 열려요';
    }
    if (headline + subline !== lastHeadline) {
      title.textContent = headline;
      sub.textContent = subline;
      lastHeadline = headline + subline;
    }

    waitDots.hidden = Boolean(state.group);
    mates.hidden = !state.group;
    mates.replaceChildren(
      ...(state.group ? state.mates : []).map((m) =>
        h(
          'li',
          {
            class: `st-mate${m.me ? ' is-me' : ''}${m.online || m.me ? '' : ' is-off'}`,
            style: m.me ? `--me:${memberColor(m.color)}` : null,
          },
          pieceIcon(memberColor(m.color)),
          h('span', { class: 'st-mate-name' }, m.name ?? '친구'),
          m.me ? h('em', {}, '나') : !m.online ? h('em', { class: 'off' }, '아직 없음') : null,
        ),
      ),
    );
    codeText.textContent = `수업 ${formatCode(state.code)} · ${state.name}`;
    rename.hidden = playing;
    if (firstDraw) focusFirst(main, 'h1');
    firstDraw = false;
  };
}

export function renderMessage(main, { title, text, action = { href: '/', label: '처음으로' }, onAction, tone = 'plain' }) {
  const button = onAction
    ? h('button', { class: 'btn pri big', type: 'button', onclick: onAction }, action.label)
    : h('a', { class: 'btn pri big', href: action.href }, action.label);
  setScreen(
    main,
    `st-center st-message st-${tone}`,
    title,
    h('div', { class: 'st-bigicon' }, pieceIcon(tone === 'ended' ? '#22A559' : '#B4AC9E')),
    h('h1', { tabindex: '-1' }, title),
    h('p', { class: 'sub' }, text),
    button,
  );
  focusFirst(main, 'h1');
}
