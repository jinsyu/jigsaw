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

export function practiceUrl(key, pieces) {
  return `/play?${new URLSearchParams({ demo: '1', picture: key, pieces: String(pieces) })}`;
}

export async function setupPractice(section, fetchImpl = globalThis.fetch) {
  const list = section.querySelector('.practice-list');
  const more = section.querySelector('.practice-more');
  const pieceButtons = [...section.querySelectorAll('.practice-pieces button')];
  let pieces = PRACTICE_PIECES[0];
  let images = [];

  const response = await fetchImpl(BUILTIN_INDEX);
  if (!response.ok) return;
  images = (await response.json()).images ?? [];
  if (!images.length) return;

  function render() {
    list.replaceChildren(
      ...practicePicks(images).map((image) => {
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
  more.addEventListener('click', render);
  render();
  setPieces(pieces);
  section.hidden = false;
}
