import { enhanceCodeField } from './code-field.js';
import { matchRoute } from './routes.js';
import { latestSaved } from './student/saved.js';

const TITLES = {
  join: '들어가기',
  play: '퍼즐',
  teacher: '선생님',
  notFound: '페이지를 찾을 수 없어요',
};

function setupHome() {
  enhanceCodeField(document.querySelector('.code-form .code-field'));
  const saved = latestSaved(localStorage);
  if (saved) showResume(saved);
  const practice = document.querySelector('.home .practice');
  if (practice) {
    import('./home-practice.js')
      .then(({ setupPractice }) => setupPractice(practice))
      .catch((error) => console.error(error));
  }
}

// Same device, same class: one tap back to the waiting screen (or the puzzle).
function showResume(saved) {
  const link = document.createElement('a');
  link.className = 'resume';
  link.href = `/join?code=${saved.code}`;
  const label = document.createElement('span');
  label.className = 'resume-label';
  label.textContent = '이어서 하기';
  const detail = document.createElement('span');
  detail.className = 'resume-detail';
  detail.textContent = `수업 ${saved.code.slice(0, 3)} ${saved.code.slice(3)} · ${saved.name}`;
  const arrow = document.createElement('span');
  arrow.className = 'resume-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';
  link.append(label, detail, arrow);
  document.querySelector('.home .hint').after(link);
}

// Non-home screens share index.html, so drop the home canonical and keep them out of search.
function markPrivate(title) {
  document.title = `${title} | 조각조각`;
  document.querySelector('link[rel="canonical"]')?.remove();
  const robots = document.createElement('meta');
  robots.name = 'robots';
  robots.content = 'noindex, follow';
  document.head.append(robots);
}

// A plain screen with a heading, one line and a way back home (unknown address, load error).
function renderPlaceholder(main, title, note = '주소를 다시 확인하거나 처음 화면에서 시작해 주세요.') {
  main.className = 'page placeholder';
  main.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = title;
  const line = document.createElement('p');
  line.className = 'sub';
  line.textContent = note;
  const back = document.createElement('a');
  back.className = 'btn';
  back.href = '/';
  back.textContent = '처음 화면으로';
  main.append(heading, line, back);
}

function showLoadError(main, error) {
  document.documentElement.classList.remove('is-play');
  renderPlaceholder(main, '화면을 열지 못했어요', '새로고침해 주세요. 계속 안 되면 선생님께 알려 주세요.');
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
} else if (route === 'join' || route === 'play') {
  markPrivate(TITLES[route]);
  main.replaceChildren(); // the student screens draw themselves
  import('./student/app.js')
    .then(({ startStudent }) => startStudent(main, route))
    .catch((error) => showLoadError(main, error));
} else if (route === 'teacher') {
  markPrivate(TITLES.teacher);
  main.replaceChildren(); // do not flash the home screen while the teacher screens load
  import('./teacher/app.js')
    .then(({ startTeacher }) => startTeacher(main))
    .catch((error) => showLoadError(main, error));
} else {
  markPrivate(TITLES[route]);
  renderPlaceholder(main, TITLES[route]);
}
