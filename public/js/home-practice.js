// Home page '혼자 맞춰 보기': a few built-in pictures anyone (a student without a code, a
// teacher before signing in) can put together alone on /play?demo=1, nothing saved.
import { PIECE_COUNTS } from './puzzle/geometry.js';

const BUILTIN_INDEX = '/images/builtin/index.json';
// Same piece counts as a class.
export const PRACTICE_PIECES = PIECE_COUNTS;
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
  // The logo becomes a puzzle of a picture children like (easy pictures, photos first).
  const hero = document.querySelector('.home img.hero');
  const easy = images.filter((i) => i.level === '쉬움' && i.category === '사진');
  if (hero && easy.length) {
    const image = easy[Math.floor(Math.random() * easy.length)];
    const probe = new Image();
    probe.src = image.thumb;
    probe.decode().then(() => hero.replaceWith(pictureHero(image)), () => {});
  }
  // Sent here from a finished puzzle (/#practice): the section shows only now, so go to it now.
  if (location.hash === '#practice') section.scrollIntoView({ block: 'start' });
}

// Home hero: one easy picture cut into the four pieces of the logo (images/hero.svg), which
// slide together when the page opens (CSS; still for reduced motion). Replaces the plain logo
// picture, same size, so nothing moves around it.
const HERO_PIECES = [
  ['M0.0 0.0C33.3 0.0 66.7 0.0 100.0 0.0C100.0 11.1 100.0 22.1 100.0 33.2C100.0 42.3 95.9 44.4 91.9 41.3C85.7 35.2 72.5 35.2 72.5 48.4C72.5 61.7 85.7 61.7 91.9 55.6C95.9 52.5 100.0 54.6 100.0 63.7C100.0 75.8 100.0 87.9 100.0 100.0C86.9 100.0 73.9 100.0 60.8 100.0C52.2 100.0 50.2 103.9 53.1 107.7C58.9 113.5 58.9 126.0 46.4 126.0C33.8 126.0 33.8 113.5 39.6 107.7C42.5 103.9 40.6 100.0 31.9 100.0C21.3 100.0 10.6 100.0 0.0 100.0C0.0 66.7 0.0 33.3 0.0 0.0Z', '#F0544F'],
  ['M100.0 0.0C133.3 0.0 166.7 0.0 200.0 0.0C200.0 33.3 200.0 66.7 200.0 100.0C187.5 100.0 175.0 100.0 162.5 100.0C153.9 100.0 152.0 96.2 154.9 92.3C160.6 86.5 160.6 74.0 148.1 74.0C135.6 74.0 135.6 86.5 141.4 92.3C144.3 96.2 142.4 100.0 133.7 100.0C122.5 100.0 111.2 100.0 100.0 100.0C100.0 87.9 100.0 75.8 100.0 63.7C100.0 54.6 95.9 52.5 91.9 55.6C85.7 61.7 72.5 61.7 72.5 48.4C72.5 35.2 85.7 35.2 91.9 41.3C95.9 44.4 100.0 42.3 100.0 33.2C100.0 22.1 100.0 11.1 100.0 0.0Z', '#22A559'],
  ['M0.0 100.0C10.6 100.0 21.3 100.0 31.9 100.0C40.6 100.0 42.5 103.9 39.6 107.7C33.8 113.5 33.8 126.0 46.4 126.0C58.9 126.0 58.9 113.5 53.1 107.7C50.2 103.9 52.2 100.0 60.8 100.0C73.9 100.0 86.9 100.0 100.0 100.0C100.0 112.7 100.0 125.4 100.0 138.1C100.0 146.6 103.8 148.5 107.6 145.7C113.3 140.0 125.6 140.0 125.6 152.3C125.6 164.6 113.3 164.6 107.6 159.0C103.8 156.1 100.0 158.0 100.0 166.5C100.0 177.7 100.0 188.8 100.0 200.0C66.7 200.0 33.3 200.0 0.0 200.0C0.0 166.7 0.0 133.3 0.0 100.0Z', '#3B82F6'],
  ['M100.0 100.0C111.2 100.0 122.5 100.0 133.7 100.0C142.4 100.0 144.3 96.2 141.4 92.3C135.6 86.5 135.6 74.0 148.1 74.0C160.6 74.0 160.6 86.5 154.9 92.3C152.0 96.2 153.9 100.0 162.5 100.0C175.0 100.0 187.5 100.0 200.0 100.0C200.0 133.3 200.0 166.7 200.0 200.0C166.7 200.0 133.3 200.0 100.0 200.0C100.0 188.8 100.0 177.7 100.0 166.5C100.0 158.0 103.8 156.1 107.6 159.0C113.3 164.6 125.6 164.6 125.6 152.3C125.6 140.0 113.3 140.0 107.6 145.7C103.8 148.5 100.0 146.6 100.0 138.1C100.0 125.4 100.0 112.7 100.0 100.0Z', '#F2A20C'],
];
const SVG_NS = 'http://www.w3.org/2000/svg';

export function pictureHero(image) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '-30 -30 260 260');
  svg.setAttribute('class', 'hero hero-picture');
  svg.setAttribute('width', '170');
  svg.setAttribute('height', '170');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `퍼즐 조각으로 나눈 그림: ${image.title}`);
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.append(defs);
  HERO_PIECES.forEach(([d, color], i) => {
    const clip = document.createElementNS(SVG_NS, 'clipPath');
    clip.id = `hero-piece-${i}`;
    const shape = document.createElementNS(SVG_NS, 'path');
    shape.setAttribute('d', d);
    clip.append(shape);
    defs.append(clip);
    const piece = document.createElementNS(SVG_NS, 'g');
    piece.setAttribute('class', `hero-piece hero-piece-${i}`);
    const picture = document.createElementNS(SVG_NS, 'image');
    picture.setAttribute('href', image.thumb);
    picture.setAttribute('x', '0');
    picture.setAttribute('y', '0');
    picture.setAttribute('width', '200');
    picture.setAttribute('height', '200');
    picture.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    picture.setAttribute('clip-path', `url(#hero-piece-${i})`);
    const edge = document.createElementNS(SVG_NS, 'path');
    edge.setAttribute('d', d);
    edge.setAttribute('fill', 'none');
    edge.setAttribute('stroke', '#fff');
    edge.setAttribute('stroke-width', '4');
    edge.setAttribute('stroke-linejoin', 'round');
    piece.dataset.color = color;
    piece.append(picture, edge);
    svg.append(piece);
  });
  return svg;
}
