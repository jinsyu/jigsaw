// Teacher screens under /teacher: sign-in, 내 수업, 새 수업, 내 그림, and the session lobby.
// Loaded on demand by js/app.js so student pages never download supabase-js.
import { isConfigured, pickConfig } from '../config.js';
import { getTeacherClient } from '../supabase-client.js';
import { h, nodes as present, pieceIcon, setTitle } from './dom.js';
import { parseTeacherPath } from './routes.js';
import { renderHome } from './home-view.js';
import { renderCreate } from './create-view.js';
import { renderImages } from './images-view.js';
import { renderLobby } from './lobby-view.js';
import { renderLogin, renderNotReady } from './login-view.js';

const STYLESHEET = '/css/teacher.css';

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

// Reads ?error_description=... left by a failed Google sign-in, and drops the
// OAuth parameters (?code=, ?error=) from the address bar.
function takeOAuthResult() {
  const url = new URL(location.href);
  const failed = url.searchParams.has('error') || url.searchParams.has('error_description');
  let changed = false;
  for (const key of ['code', 'error', 'error_code', 'error_description', 'state']) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return failed ? '로그인하지 못했어요. 다시 시도해 주세요.' : '';
}

const isTeacherSession = (session) => Boolean(session?.user && !session.user.is_anonymous);

function teacherName(user) {
  const meta = user.user_metadata ?? {};
  const name = meta.full_name || meta.name || (user.email ?? '').split('@')[0] || '선생';
  return name;
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

  if (!isConfigured(config)) {
    renderNotReady(main);
    return;
  }

  main.append(h('p', { class: 't-loading', role: 'status' }, '선생님 화면을 여는 중이에요…'));
  let client;
  let session;
  try {
    client = await getTeacherClient(config);
    ({ data: { session } } = await client.auth.getSession());
  } catch (error) {
    console.error(error);
    renderStartError(main);
    return;
  }
  const loginError = takeOAuthResult();
  const bar = h('header', { class: 't-bar', hidden: true });
  main.before(bar);
  let user = isTeacherSession(session) ? session.user : null;
  let cleanup = null;
  let firstRender = true;

  const ctx = {
    client,
    config,
    get user() {
      return user;
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
      const brand = h('a', { class: 'brand', href: '/teacher', 'aria-label': '함께 퍼즐 내 수업' }, pieceIcon(), '함께 퍼즐');
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
      const name = teacherName(user);
      const account = h(
        'div',
        { class: 't-account' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, name.slice(0, 1)),
        h('span', { class: 't-name' }, `${name} 선생님`),
        h('button', { class: 'btn t-logout', type: 'button', onclick: signOut }, '로그아웃'),
      );
      bar.replaceChildren(brand, nav, account);
    },
  };

  async function signOut() {
    // 'local' clears this browser even when the network is down.
    await client.auth.signOut({ scope: 'local' });
  }

  function render() {
    cleanup?.();
    cleanup = null;
    main.replaceChildren();
    main.className = 'teacher';
    main.removeAttribute('aria-busy');
    document.documentElement.classList.remove('is-lobby');
    window.scrollTo(0, 0);

    if (!user) {
      ctx.setBar('none');
      setTitle('선생님 로그인');
      renderLogin(main, ctx, { error: firstRender ? loginError : '' });
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

  client.auth.onAuthStateChange((event, session) => {
    const next = isTeacherSession(session) ? session.user : null;
    if ((next?.id ?? null) === (user?.id ?? null)) {
      user = next; // token refresh: same teacher, keep the screen
      return;
    }
    user = next;
    // Leave the callback before rendering: supabase-js holds a lock while it runs.
    setTimeout(render, 0);
  });

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

  render();
}

// Moves focus to the heading unless the teacher has already moved it somewhere on the page.
function focusHeadingIfIdle(main) {
  const active = document.activeElement;
  if (active && active !== document.body && main.contains(active)) return;
  main.querySelector('h1')?.focus({ preventScroll: true });
}

function renderStartError(main) {
  setTitle('화면을 열지 못했어요');
  main.removeAttribute('aria-busy');
  main.className = 'teacher t-center';
  main.replaceChildren(
    h(
      'section',
      { class: 'card t-login-card' },
      h('h1', {}, '화면을 열지 못했어요'),
      h('p', { class: 'sub' }, '인터넷 연결을 확인하고 새로고침해 주세요.'),
      h('button', { class: 'btn pri big', type: 'button', onclick: () => location.reload() }, '새로고침'),
    ),
  );
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
