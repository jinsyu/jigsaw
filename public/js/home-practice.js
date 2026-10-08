// Home page '혼자 맞춰 보기': a few built-in pictures anyone (a student without a code, a
// teacher before signing in) can put together alone on /play?demo=1, nothing saved.
const BUILTIN_INDEX = '/images/builtin/index.json';
export const PRACTICE_PIECES = [12, 24, 48];
const SHOWN = 8;
// Easy pictures first: the youngest children open this page too.
const LEVEL_ORDER = { 쉬움: 0, 보통: 1, 어려움: 2 };

// `count` pictures in a random order, easier ones first; `random` returns [0, 1).
export function practicePicks(images, count = SHOWN, random = Math.random) {
  return images
    .map((image) => ({ image, key: (LEVEL_ORDER[image.level] ?? 1) + random() * 1.5 }))
    .sort((a, b) => a.key - b.key)
    .slice(0, count)
    .map(({ image }) => image);
}

// Themes children pick from (the first shows every picture).
export const PRACTICE_THEMES = [
  { label: '전체', test: () => true },
  { label: '동물', test: (i) => i.topic === '동물' && !(i.tags ?? []).includes('공룡') },
  { label: '공룡', test: (i) => (i.tags ?? []).includes('공룡') },
  { label: '탈것', test: (i) => i.topic === '탈것' },
  { label: '우주', test: (i) => i.topic === '우주·과학' },
  { label: '바다', test: (i) => i.topic === '바다' },
  { label: '이야기', test: (i) => i.topic === '상상·이야기' },
];

export function practiceUrl(key, pieces) {
  return `/play?${new URLSearchParams({ demo: '1', picture: key, pieces: String(pieces) })}`;
}

export async function setupPractice(section, fetchImpl = globalThis.fetch) {
  const list = section.querySelector('.practice-list');
  const more = section.querySelector('.practice-more');
  const pieceButtons = [...section.querySelectorAll('.practice-pieces button')];
  const themeRow = section.querySelector('.practice-themes');
  let pieces = PRACTICE_PIECES[0];
  let images = [];
  let theme = PRACTICE_THEMES[0];

  const response = await fetchImpl(BUILTIN_INDEX);
  if (!response.ok) return;
  images = (await response.json()).images ?? [];
  if (!images.length) return;

  function render() {
    list.replaceChildren(
      ...practicePicks(images.filter(theme.test)).map((image) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'practice-card';
        link.href = practiceUrl(image.key, pieces);
        link.dataset.key = image.key;
        const img = document.createElement('img');
        img.src = image.thumb;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        const title = document.createElement('span');
        title.textContent = image.title;
        link.append(img, title);
        item.append(link);
        return item;
      }),
    );
  }
  function setPieces(n) {
    pieces = n;
    for (const button of pieceButtons) button.setAttribute('aria-pressed', String(Number(button.dataset.pieces) === n));
    for (const link of list.querySelectorAll('.practice-card')) link.href = practiceUrl(link.dataset.key, n);
  }
  for (const button of pieceButtons) button.addEventListener('click', () => setPieces(Number(button.dataset.pieces)));
  const themes = PRACTICE_THEMES.filter((t) => images.some(t.test));
  const themeButtons = themes.map((t) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t.label;
    button.setAttribute('aria-pressed', String(t === theme));
    button.addEventListener('click', () => {
      theme = t;
      for (const [i, b] of themeButtons.entries()) b.setAttribute('aria-pressed', String(themes[i] === t));
      render();
      setPieces(pieces);
    });
    return button;
  });
  themeRow?.replaceChildren(...themeButtons);
  more.addEventListener('click', () => {
    render();
    setPieces(pieces);
  });
  render();
  setPieces(pieces);
  section.hidden = false;
  // Sent here from a finished puzzle (/#practice): the section shows only now, so go to it now.
  if (location.hash === '#practice') section.scrollIntoView({ block: 'start' });
}
