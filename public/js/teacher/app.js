// Teacher screens under /teacher: sign-in, 조각조각 시작하기, 내 수업, 새 수업, 내 그림, and the
// class lobby. Loaded on demand by js/app.js. Everything goes through the rt server
// (rt-client.js) with the teacher token from sign-in; nothing here talks to Supabase.
import { hasRtServer, pickConfig } from '../config.js';
import { RtError, rtRequest } from '../rt-client.js';
import { clearTeacherAuth, readTeacherAuth, saveTeacherAuth, teacherLabel, tokenExpiry } from './auth.js';
import { h, nodes as present, pieceIcon, setTitle } from './dom.js';
import { parseTeacherPath } from './routes.js';
import { renderHome } from './home-view.js';
import { renderCreate } from './create-view.js';
import { renderImages } from './images-view.js';
import { renderLobby } from './lobby-view.js';
import { renderLogin, renderNotReady } from './login-view.js';
import { renderStart } from './start-view.js';

const STYLESHEET = '/css/teacher.css';
// setTimeout cannot wait longer than this (about 24.8 days).
const MAX_TIMER_MS = 2 ** 31 - 1;

function loadStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
  return new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href });
    // Render even if the stylesheet fails: unstyled is better than a blank page.
    link.addEventListener('load', resolve);
    link.addEventListener('error', resolve);
    document.head.append(link);
  });
}

const NAV = [
  { view: 'home', href: '/teacher', label: '내 수업' },
  { view: 'new', href: '/teacher/new', label: '새 수업' },
  { view: 'images', href: '/teacher/images', label: '내 그림' },
];

export async function startTeacher(main) {
  document.documentElement.classList.add('is-teacher');
  main.className = 'teacher';
  main.replaceChildren();
  main.setAttribute('aria-busy', 'true');
  const config = pickConfig(location.hostname);
  await loadStylesheet(STYLESHEET);

  if (!hasRtServer(config)) {
    renderNotReady(main);
    return;
  }

  const bar = h('header', { class: 't-bar', hidden: true });
  // "다시 연결하는 중" while a live screen (lobby, overview) has lost the rt server.
  const band = h('p', { class: 't-band', role: 'status', hidden: true }, h('i', { class: 'dot is-lost' }), '서버와 연결이 끊겼어요. 다시 연결하는 중이에요…');
  main.before(bar, band);
  let auth = readTeacherAuth(localStorage);
  let start = null; // { startTicket, displayName } between Google sign-in and 조각조각 시작하기
  let notice = ''; // shown once on the sign-in screen
  let cleanup = null;
  let firstRender = true;
  let expiryTimer = 0;

  function signOut(message = '') {
    clearTeacherAuth(localStorage);
    clearTimeout(expiryTimer);
    window.google?.accounts?.id?.disableAutoSelect?.();
    auth = null;
    start = null;
    notice = message;
    render();
  }

  // The token ends after 12 hours: back to the sign-in screen at that moment, not on the next tap.
  function watchExpiry() {
    clearTimeout(expiryTimer);
    if (!auth) return;
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, tokenExpiry(auth.token) - Date.now() - 60_000));
    expiryTimer = setTimeout(() => {
      if (!readTeacherAuth(localStorage)) signOut('로그인한 지 오래되어 다시 로그인해 주세요.');
      else watchExpiry();
    }, wait);
  }

  // Requests with the teacher token. A refused token signs the teacher out.
  async function request(path, options = {}) {
    try {
      return await rtRequest(config.rtUrl, path, { ...options, token: auth?.token });
    } catch (error) {
      if (error instanceof RtError && (error.code === 'invalid_token' || error.code === 'not_teacher') && auth) {
        signOut('다시 로그인해 주세요.');
      }
      throw error;
    }
  }

  const ctx = {
    config,
    get auth() {
      return auth;
    },
    api: {
      get: (path) => request(path),
      post: (path, json) => request(path, { method: 'POST', json }),
      del: (path) => request(path, { method: 'DELETE' }),
      upload: (path, blob) => request(path, { method: 'POST', body: blob, contentType: blob.type }),
      // Sign-in requests carry no teacher token.
      public: (path, json) => rtRequest(config.rtUrl, path, { method: 'POST', json }),
    },
    signedIn({ token, teacher }) {
      auth = { token, displayName: teacher?.displayName ?? '' };
      saveTeacherAuth(localStorage, auth);
      start = null;
      notice = '';
      watchExpiry();
      render();
    },
    needsStart({ startTicket, profile }) {
      start = { startTicket, displayName: profile?.displayName ?? '' };
      render();
    },
    cancelStart(message = '') {
      start = null;
      notice = message;
      render();
    },
    signOut,
    setReconnecting(on) {
      band.hidden = !on;
    },
    navigate(path, { replace = false } = {}) {
      if (replace) history.replaceState(null, '', path);
      else history.pushState(null, '', path);
      render();
    },
    // mode 'nav': brand + menu + account. Otherwise `nodes` fill the bar (lobby).
    setBar(mode, { active, nodes = [] } = {}) {
      bar.hidden = mode === 'none';
      bar.className = `t-bar t-bar-${mode}`;
      const brand = h('a', { class: 'brand', href: '/teacher', 'aria-label': '조각조각 내 수업' }, pieceIcon(), '조각조각');
      if (mode !== 'nav') {
        bar.replaceChildren(brand, ...present(nodes));
        return;
      }
      const nav = h(
        'nav',
        { class: 't-nav', 'aria-label': '선생님 메뉴' },
        NAV.map((item) =>
          h('a', { href: item.href, 'aria-current': item.view === active ? 'page' : null }, item.label),
        ),
      );
      const label = teacherLabel(auth?.displayName);
      const account = h(
        'div',
        { class: 't-account' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, label.slice(0, 1)),
        h('span', { class: 't-name' }, label),
        h('button', { class: 'btn t-logout', type: 'button', onclick: () => signOut() }, '로그아웃'),
      );
      bar.replaceChildren(brand, nav, account);
    },
  };

  function render() {
    cleanup?.();
    cleanup = null;
    band.hidden = true;
    main.replaceChildren();
    main.className = 'teacher';
    main.removeAttribute('aria-busy');
    document.documentElement.classList.remove('is-lobby');
    window.scrollTo(0, 0);

    if (!auth && start) {
      ctx.setBar('none');
      cleanup = renderStart(main, ctx, start) ?? null;
    } else if (!auth) {
      ctx.setBar('none');
      setTitle('선생님 로그인');
      cleanup = renderLogin(main, ctx, { notice }) ?? null;
      notice = '';
    } else {
      const route = parseTeacherPath(location.pathname);
      const views = { home: renderHome, new: renderCreate, images: renderImages, session: renderLobby };
      const view = views[route.view] ?? renderNotFound;
      // Views whose heading appears only after their data loads call ctx.headingReady().
      ctx.headingReady = firstRender ? () => {} : () => focusHeadingIfIdle(main);
      cleanup = view(main, ctx, route) ?? null;
    }
    // After in-app navigation, move focus to the new heading for screen readers.
    if (!firstRender) main.querySelector('h1')?.focus({ preventScroll: true });
    firstRender = false;
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/teacher')) return;
    event.preventDefault();
    if (url.pathname + url.search !== location.pathname + location.search) ctx.navigate(url.pathname + url.search);
  });
  window.addEventListener('popstate', render);

  watchExpiry();
  render();
}

// Moves focus to the heading unless the teacher has already moved it somewhere on the page.
function focusHeadingIfIdle(main) {
  const active = document.activeElement;
  if (active && active !== document.body && main.contains(active)) return;
  main.querySelector('h1')?.focus({ preventScroll: true });
}

function renderNotFound(main, ctx) {
  ctx.setBar('nav', { active: null });
  setTitle('페이지를 찾을 수 없어요');
  main.append(
    h(
      'div',
      { class: 't-wrap' },
      h(
        'section',
        { class: 'card t-empty' },
        h('h1', { tabindex: '-1' }, '페이지를 찾을 수 없어요'),
        h('p', { class: 'sub' }, '주소가 바뀌었거나 지워진 화면이에요.'),
        h('a', { class: 'btn pri', href: '/teacher' }, '내 수업으로'),
      ),
    ),
  );
}
