// 함께 퍼즐 시작하기: once, for a gyosil account that is not a jigsaw teacher yet (spec F1).
// The name shown on the teacher screens and the consent; POST /api/teacher/start saves them in
// the shared gyosil profile (core.profiles) and makes the jigsaw.teachers row.
// The name field starts with the name the teacher already uses in other gyosil apps.
import { RtError } from '../rt-client.js';
import { h, pieceIcon, setTitle } from './dom.js';

export const TEACHER_NAME_MAX = 40; // server/src/http.js

export function startErrorMessage(error) {
  if (error instanceof RtError && error.network) return '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';
  if (error instanceof RtError && error.code === 'invalid_name') return '이름을 적어 주세요.';
  if (error instanceof RtError && error.code === 'terms_required') return '개인정보 처리방침에 동의해 주세요.';
  return '시작하지 못했어요. 잠시 뒤 다시 눌러 주세요.';
}

export function renderStart(main, ctx, { startTicket, displayName }) {
  setTitle('함께 퍼즐 시작하기');
  main.className = 'teacher t-center';
  let alive = true;
  const known = (displayName ?? '').trim();
  const name = h('input', {
    class: 't-text-input',
    id: 't-start-name',
    type: 'text',
    name: 'displayName',
    autocomplete: 'name',
    maxlength: String(TEACHER_NAME_MAX),
    required: true,
    'aria-describedby': 't-start-name-note',
  });
  name.value = known.slice(0, TEACHER_NAME_MAX);
  const agree = h('input', { class: 't-agree-input', id: 't-start-agree', type: 'checkbox', required: true });
  const error = h('p', { class: 't-error', role: 'alert' });
  const submit = h('button', { class: 'btn pri big', type: 'submit' }, '시작하기');
  const other = h('button', { class: 'btn t-start-other', type: 'button', onclick: () => ctx.cancelStart() }, '다른 계정으로 로그인');
  const form = h(
    'form',
    { class: 't-start-form', novalidate: true },
    h('label', { class: 't-label', for: 't-start-name' }, '선생님 이름'),
    name,
    h(
      'p',
      { class: 't-hint', id: 't-start-name-note' },
      known ? '다른 교실 앱에서 쓰는 이름을 넣어 두었어요. 바꿔도 돼요.' : '선생님 화면 위쪽에 ‘○○ 선생님’으로 보여요.',
    ),
    h(
      'label',
      { class: 't-agree', for: 't-start-agree' },
      agree,
      h('span', {}, h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, '개인정보 처리방침'), '을 읽었고 동의해요.'),
    ),
    error,
    submit,
    other,
  );
  const card = h(
    'section',
    { class: 'card t-login-card t-start-card', 'aria-labelledby': 't-start-title' },
    h('span', { class: 'brand t-login-brand' }, pieceIcon(), '함께 퍼즐'),
    h('h1', { id: 't-start-title', tabindex: '-1' }, '함께 퍼즐 시작하기'),
    h('p', { class: 'sub' }, '처음 한 번만 하면 돼요. 학생 이름이나 사진은 받지 않아요.'),
    form,
  );
  main.append(card);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const value = name.value.trim();
    if (!value) {
      error.textContent = '이름을 적어 주세요.';
      name.focus();
      return;
    }
    if (!agree.checked) {
      error.textContent = '개인정보 처리방침에 동의해 주세요.';
      agree.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = '시작하는 중…';
    try {
      const answer = await ctx.api.public('/api/teacher/start', { startTicket, displayName: value, agreed: true });
      if (alive) ctx.signedIn(answer);
    } catch (err) {
      console.error(err);
      if (!alive) return;
      // The ticket lasts 15 minutes: after that, sign in with Google again.
      if (err instanceof RtError && err.code === 'invalid_token') {
        ctx.cancelStart('시간이 지났어요. 구글 계정으로 다시 로그인해 주세요.');
        return;
      }
      error.textContent = startErrorMessage(err);
      submit.disabled = false;
      submit.textContent = '시작하기';
    }
  });
  return () => {
    alive = false;
  };
}
