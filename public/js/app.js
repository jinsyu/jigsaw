import { matchRoute, normalizeCode } from './routes.js';

const TITLES = {
  join: '들어가기',
  play: '퍼즐',
  teacher: '선생님',
  notFound: '페이지를 찾을 수 없어요',
};

function setupHome() {
  const input = document.getElementById('code');
  input.addEventListener('input', () => {
    const digits = normalizeCode(input.value);
    if (digits !== input.value) input.value = digits;
  });
}

// Non-home screens share index.html, so drop the home canonical and keep them out of search.
function markPrivate(title) {
  document.title = `${title} | 함께 퍼즐`;
  document.querySelector('link[rel="canonical"]')?.remove();
  const robots = document.createElement('meta');
  robots.name = 'robots';
  robots.content = 'noindex, follow';
  document.head.append(robots);
}

// Screens are built in later tasks; until then they show a simple placeholder.
function renderPlaceholder(main, title) {
  main.className = 'page placeholder';
  main.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = title;
  const note = document.createElement('p');
  note.className = 'sub';
  note.textContent = '이 화면은 준비 중이에요.';
  const back = document.createElement('a');
  back.className = 'btn';
  back.href = '/';
  back.textContent = '처음으로';
  main.append(heading, note, back);
}

function showLoadError(main, error) {
  document.documentElement.classList.remove('is-play');
  renderPlaceholder(main, '화면을 열지 못했어요');
  main.querySelector('.sub').textContent = '새로고침해 주세요. 계속 안 되면 선생님께 알려 주세요.';
  console.error(error);
}

const main = document.getElementById('app');
const route = matchRoute(location.pathname);
const isDemo = route === 'play' && new URLSearchParams(location.search).get('demo') === '1';
if (route === 'home') {
  setupHome();
} else if (isDemo) {
  markPrivate(TITLES.play);
  main.className = 'play';
  main.replaceChildren(); // do not flash the home screen while the puzzle loads
  import('./play/demo.js')
    .then(({ startDemo }) => startDemo(main))
    .catch((error) => showLoadError(main, error));
} else {
  markPrivate(TITLES[route]);
  renderPlaceholder(main, TITLES[route]);
}
