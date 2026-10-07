// Sign-in screen (Google only) and the "준비 중" screen for a host without Supabase settings.
import { GOOGLE_MARK, h, pieceIcon, setTitle } from './dom.js';

function brandLink() {
  return h('a', { class: 'brand t-login-brand', href: '/' }, pieceIcon(), '함께 퍼즐');
}

function hero() {
  return h('img', { class: 't-login-hero', src: '/images/hero.svg', alt: '', width: 112, height: 112 });
}

export function renderLogin(main, ctx, { error = '' } = {}) {
  main.className = 'teacher t-center';
  const message = h('p', { class: 't-error', role: 'alert' }, error);
  const card = h(
    'section',
    { class: 'card t-login-card', 'aria-labelledby': 't-login-title' },
    brandLink(),
    hero(),
    h('h1', { id: 't-login-title', tabindex: '-1' }, '선생님 로그인'),
    h('p', { class: 'sub' }, '구글 계정으로 들어가면 그림을 골라 수업을 열 수 있어요. 학생은 로그인 없이 코드로 들어와요.'),
    message,
  );

  if (ctx.config.googleSignIn) {
    const google = h('button', { class: 'btn big t-google', type: 'button', html: GOOGLE_MARK });
    google.append('구글 계정으로 계속하기');
    google.addEventListener('click', async () => {
      google.disabled = true;
      google.lastChild.textContent = '구글로 이동하는 중…';
      message.textContent = '';
      const { error: oauthError } = await ctx.client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${location.origin}/teacher` },
      });
      if (oauthError) {
        console.error(oauthError);
        message.textContent = '구글 로그인을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.';
        google.disabled = false;
        google.lastChild.textContent = '구글 계정으로 계속하기';
      }
    });
    card.append(google);
  }

  if (!ctx.config.googleSignIn) {
    // Local stack only: the seeded test teacher is signed in by a dev tool, not from this page.
    card.append(
      h(
        'p',
        { class: 't-dev-note' },
        '이 컴퓨터(로컬)에서는 구글 로그인을 쓸 수 없어요. 개발용 명령 ',
        h('code', {}, 'pnpm teacher:open'),
        ' 으로 시험용 선생님 화면을 열어 주세요.',
      ),
    );
  }

  card.append(
    h(
      'p',
      { class: 't-login-foot' },
      '구글 계정의 이메일 주소만 받아요. ',
      h('a', { href: '/privacy' }, '개인정보 처리방침'),
    ),
  );
  main.append(card, h('a', { class: 't-back-home', href: '/' }, '← 학생 코드 입력 화면으로'));
}

export function renderNotReady(main) {
  setTitle('준비 중');
  main.className = 'teacher t-center';
  main.removeAttribute('aria-busy');
  main.replaceChildren(
    h(
      'section',
      { class: 'card t-login-card', 'aria-labelledby': 't-ready-title' },
      brandLink(),
      hero(),
      h('h1', { id: 't-ready-title' }, '선생님 화면은 준비 중이에요'),
      h('p', { class: 'sub' }, '곧 구글 계정으로 그림을 골라 수업을 열 수 있어요. 조금만 기다려 주세요.'),
      h('a', { class: 'btn big', href: '/' }, '처음 화면으로'),
    ),
  );
}
