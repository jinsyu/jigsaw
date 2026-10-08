// Sign-in screen (Google Identity Services button) and the "준비 중" screen for a host without
// an rt server address.
//
// Google sign-in (spec "교사 인증"): GIS gets the SHA-256 of a fresh nonce and gives back an ID
// token; the rt server gets the ID token and the raw nonce (POST /api/teacher/login), checks
// both through Supabase, and answers with a teacher token, or with a start ticket for an
// account that has not started 조각조각 yet (start-view.js).
import { RtError } from '../rt-client.js';
import { makeNonce } from './auth.js';
import { h, pieceIcon, setTitle } from './dom.js';

const GIS_SCRIPT = 'https://accounts.google.com/gsi/client';

function brandLink() {
  return h('a', { class: 'brand t-login-brand', href: '/' }, pieceIcon(), '조각조각');
}

function hero() {
  return h('img', { class: 't-login-hero', src: '/images/hero.svg', alt: '', width: 112, height: 112 });
}

let gisPromise = null;

function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  gisPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SCRIPT;
    script.async = true;
    script.addEventListener('load', () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('GIS missing'))));
    script.addEventListener('error', () => reject(new Error('GIS failed to load')));
    document.head.append(script);
  }).catch((error) => {
    gisPromise = null;
    throw error;
  });
  return gisPromise;
}

export function loginErrorMessage(error) {
  if (error instanceof RtError && error.network) return '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';
  if (error instanceof RtError && error.code === 'invalid_id_token') return '구글 로그인을 확인하지 못했어요. 다시 시도해 주세요.';
  return '로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
}

// Pictures shown on the sign-in page (built-in keys; any that are missing are skipped).
const INTRO_PICTURES = ['giant-panda', 'starry-night', 'magpie-tiger', 'corgi-puppy', 'great-wave', 'macaws'];

// What 조각조각 is, beside the sign-in card, for a teacher who comes here first.
function intro() {
  const mosaic = h('div', { class: 't-intro-mosaic', 'aria-hidden': 'true' });
  fetch('/images/builtin/index.json')
    .then((response) => (response.ok ? response.json() : null))
    .then((index) => {
      const images = index?.images ?? [];
      const picked = INTRO_PICTURES.map((key) => images.find((image) => image.key === key)).filter(Boolean);
      mosaic.replaceChildren(...picked.map((image) => h('img', { src: image.thumb, alt: '', loading: 'lazy', decoding: 'async' })));
      count.textContent = images.length ? `내장 그림 ${images.length}장` : '내장 그림';
    })
    .catch(() => {});
  const count = h('li', {}, '내장 그림');
  const step = (n, title, text) => h('li', {}, h('i', { 'aria-hidden': 'true' }, String(n)), h('div', {}, h('b', {}, title), h('span', {}, text)));
  return h(
    'section',
    { class: 't-intro', 'aria-labelledby': 't-intro-title' },
    h('p', { class: 't-intro-eyebrow' }, '초등 모둠 협동 직소 퍼즐 · 무료'),
    h('h2', { id: 't-intro-title' }, '그림 한 장을 모둠이 함께 맞춰요'),
    h('p', { class: 't-intro-lead' }, '조각을 모둠원에게 나눠 주기 때문에 모두가 참여해야 완성돼요. 학급 세우기와 협동 연습에 좋아요.'),
    mosaic,
    h(
      'ol',
      { class: 't-intro-steps' },
      step(1, '수업 열기', '그림, 조각 수(12~70), 모둠 수를 고르면 수업 코드와 QR이 나와요.'),
      step(2, '학생 입장', '학생은 로그인 없이 코드와 이름만 넣고 들어와요.'),
      step(3, '함께 맞추기', '모둠마다 조각을 나눠 갖고 맞춰요. 선생님은 모둠별 진행을 한눈에 봐요.'),
    ),
    h(
      'ul',
      { class: 't-intro-facts' },
      count,
      h('li', {}, '우리 반 사진 올리기'),
      h('li', {}, '광고·채팅 없음'),
      h('li', {}, '학생 정보 저장 안 함'),
    ),
    h('a', { class: 'btn t-intro-try', href: '/play?demo=1&pieces=12' }, '로그인 없이 먼저 맞춰 보기'),
  );
}

export function renderLogin(main, ctx, { notice = '' } = {}) {
  main.className = 'teacher t-center t-login-page';
  const message = h('p', { class: 't-error', role: 'alert' }, notice);
  const card = h(
    'section',
    { class: 'card t-login-card', 'aria-labelledby': 't-login-title' },
    brandLink(),
    hero(),
    h('h1', { id: 't-login-title', tabindex: '-1' }, '선생님 로그인'),
    h('p', { class: 'sub' }, '구글 계정으로 들어가면 그림을 골라 수업을 열 수 있어요. 학생은 로그인 없이 코드로 들어와요.'),
    message,
  );
  let alive = true;

  if (ctx.config.googleClientId) {
    const slot = h('div', { class: 't-google-slot', 'aria-busy': 'true' });
    const status = h('p', { class: 'sub t-google-status', role: 'status' }, '구글 로그인 버튼을 불러오는 중이에요…');
    card.append(slot, status);
    showGoogleButton();

    async function showGoogleButton() {
      try {
        const [gis, nonce] = await Promise.all([loadGis(), makeNonce()]);
        if (!alive) return;
        gis.initialize({
          client_id: ctx.config.googleClientId,
          nonce: nonce.hashed,
          callback: ({ credential }) => signIn(credential, nonce.raw),
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        gis.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', locale: 'ko', width: 280 });
        status.textContent = '';
      } catch (error) {
        console.error(error);
        if (!alive) return;
        status.textContent = '';
        message.textContent = '구글 로그인을 열지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.';
      } finally {
        slot.removeAttribute('aria-busy');
      }
    }

    async function signIn(idToken, nonce) {
      message.textContent = '';
      status.textContent = '로그인하는 중이에요…';
      try {
        const answer = await ctx.api.public('/api/teacher/login', { idToken, nonce });
        if (!alive) return;
        if (answer.needsStart) ctx.needsStart(answer);
        else ctx.signedIn(answer);
      } catch (error) {
        console.error(error);
        if (!alive) return;
        status.textContent = '';
        message.textContent = loginErrorMessage(error);
        // A nonce is good for one sign-in: a fresh one for the next try.
        showGoogleButton();
      }
    }
  } else {
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
  main.append(
    h('div', { class: 't-login-wrap' }, h('div', { class: 't-login-side' }, card, h('a', { class: 't-back-home', href: '/' }, '← 학생 코드 입력 화면으로')), intro()),
  );
  return () => {
    alive = false;
  };
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
