// Builds the built-in pictures:
// - self-made scenes: the mockup scenes (docs/mockups/src/common.js) and the scenes in
//   scripts/builtin-scenes.mjs, rendered from SVG;
// - outside pictures (public domain, CC0, 공공누리 제1유형): scripts/builtin-external.json,
//   downloaded into BUILTIN_ORIGINALS (default: the OS temp folder, never the repository),
//   cropped or joined as recorded there, and resized.
// Writes public/images/builtin/<key>.webp (long side 1800), <key>-thumb.webp (long side 720)
// and index.json. Usage: pnpm images:builtin   (needs network: the Pretendard font, originals)
// Sources, licences and checks: docs/image-candidates.md.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { SCENES } from './builtin-scenes.mjs';
import { withCredits } from './lib/privacy-credits.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public/images/builtin');
const SCALE = { full: 3, thumb: 1.2 }; // a 600 x 400 scene -> 1800 x 1200 and 720 x 480
const QUALITY = { full: 0.86, thumb: 0.8 };
const LONG_SIDE = { full: 1800, thumb: 720 }; // outside pictures keep their own proportions
const RASTER_QUALITY = { full: 0.8, thumb: 0.78 };
// Whole classes load a picture at once on school Wi-Fi: keep files under these sizes
// (the encoder quality steps down until they fit, but not below RASTER_MIN_QUALITY).
const MAX_BYTES = { full: 500_000, thumb: 80_000 };
const RASTER_MIN_QUALITY = 0.5;
const EXTERNAL = JSON.parse(readFileSync(join(ROOT, 'scripts/builtin-external.json'), 'utf8'));
const ORIGINALS = process.env.BUILTIN_ORIGINALS ?? join(tmpdir(), 'jigsaw-builtin-originals');
const USER_AGENT = 'JigsawClassroomBot/0.1 (educational puzzle; contact jinsyu.com@gmail.com)';

// key: file and builtin_key name, scene: mockup scene id.
// Text that only made sense in the mockup (a date, a class number) is made general.
const PICTURES = [
  { key: 'sea', scene: 'sea', title: '바다 친구들', category: '자연' },
  { key: 'village', scene: 'village', title: '숲속 마을', category: '자연' },
  { key: 'space', scene: 'space', title: '우주 여행', category: '과학' },
  { key: 'garden', scene: 'garden', title: '꽃밭', category: '자연' },
  {
    key: 'classroom',
    scene: 'classroom',
    title: '우리 반 교실',
    category: '학교',
    replace: [['3월 4일 · 우리 반 첫 활동', '우리 반 첫 활동']],
  },
  { key: 'friends', scene: 'group', title: '우리 반 친구들', category: '학교', replace: [['4학년 2반', '우리 반']] },
  ...SCENES,
];
// index.json image entry:
//   { key, title, category, width, height, src, thumb,
//     source:  { name, author, url },   who made it and where it came from
//     license: { name, url },           what may be done with it
//     credit,                           one line to show: 작품명, 작가, 연도 — 소장처 / 이미지, 라이선스
//     year?, holder?, note?, topic? }   outside pictures: when, who keeps it, what was changed
// category: 자체 제작 | 명화 | 우리 그림 | 사진 | 삽화. Self-made scenes have author '함께 퍼즐'
// and no URLs (topic keeps their theme). Outside pictures must give source.author,
// source.url and license.url.
const SELF_MADE = '자체 제작';
const SOURCE = { name: '함께 퍼즐 자체 제작', author: '함께 퍼즐', url: null };
const LICENSE = { name: '함께 퍼즐 수업용으로 자유롭게 사용', url: null };

// Mockup scenes are 600 x 400; the others say their own size (400 x 600 for portrait).
const sceneW = (picture) => picture.width ?? 600;
const sceneH = (picture) => picture.height ?? 400;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1800 } });
  await page.setContent(
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">' +
      '<style>body{margin:0}svg{display:block}</style><div id="stage"></div>',
    { waitUntil: 'networkidle' },
  );
  await page.addScriptTag({ path: join(ROOT, 'docs/mockups/src/common.js') });

  const index = [];
  for (const picture of PICTURES) {
    await page.evaluate(
      async ({ picture, sceneW, sceneH }) => {
        let svg = picture.svg ?? window.M.SCENES[picture.scene].svg;
        for (const [from, to] of picture.replace ?? []) {
          if (!svg.includes(from)) throw new Error(`text not found in ${picture.scene}: ${from}`);
          svg = svg.replace(from, to);
        }
        // Inline SVG (not <img>) so the scene text uses the page web font.
        document.getElementById('stage').innerHTML =
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sceneW} ${sceneH}">${svg}</svg>`;
        await document.fonts.load('700 38px Pretendard', '함께 퍼즐 우리 반 첫 활동');
        await document.fonts.ready;
      },
      { picture, sceneW: sceneW(picture), sceneH: sceneH(picture) },
    );

    for (const name of ['full', 'thumb']) {
      const size = {
        width: sceneW(picture) * SCALE[name],
        height: sceneH(picture) * SCALE[name],
        quality: QUALITY[name],
      };
      // Screenshot the SVG at the target size, then re-encode the PNG as WebP in the page.
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate(({ width, height }) => {
        const svg = document.querySelector('#stage svg');
        svg.setAttribute('width', width);
        svg.setAttribute('height', height);
      }, size);
      const png = await page.locator('#stage svg').screenshot({ type: 'png' });
      const webp = await page.evaluate(
        async ({ base64, width, height, quality }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${base64}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          const url = canvas.toDataURL('image/webp', quality);
          if (!url.startsWith('data:image/webp')) throw new Error('this browser cannot encode WebP');
          return url.slice(url.indexOf(',') + 1);
        },
        { base64: png.toString('base64'), ...size },
      );
      const file = name === 'full' ? `${picture.key}.webp` : `${picture.key}-thumb.webp`;
      writeFileSync(join(OUT, file), Buffer.from(webp, 'base64'));
    }
    index.push({
      key: picture.key,
      title: picture.title,
      category: SELF_MADE,
      topic: picture.category,
      width: sceneW(picture) * SCALE.full,
      height: sceneH(picture) * SCALE.full,
      src: `/images/builtin/${picture.key}.webp`,
      thumb: `/images/builtin/${picture.key}-thumb.webp`,
      source: SOURCE,
      license: LICENSE,
      credit: `${picture.title} — ${SOURCE.name}`,
    });
  }

  for (const picture of EXTERNAL) index.push(await renderExternal(page, picture));
  writeFileSync(join(OUT, 'index.json'), `${JSON.stringify({ version: 1, images: index }, null, 2)}\n`);
  // The privacy page names the source of every outside picture: keep it in step.
  const privacy = join(ROOT, 'public/privacy.html');
  writeFileSync(privacy, withCredits(readFileSync(privacy, 'utf8'), index));
} finally {
  await browser.close();
}
console.log(`Wrote ${PICTURES.length + EXTERNAL.length} built-in pictures to public/images/builtin/`);

// Downloads (once) the original image files of an outside picture.
async function originals(picture) {
  mkdirSync(ORIGINALS, { recursive: true });
  const files = [];
  for (const [i, url] of picture.images.entries()) {
    const file = join(ORIGINALS, `${picture.key}-${i}${extname(new URL(url).pathname).toLowerCase() || '.jpg'}`);
    if (!existsSync(file)) {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!response.ok) throw new Error(`${picture.key}: ${response.status} ${url}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    files.push(file);
  }
  return files;
}

// Panels side by side (same height), then the recorded crop (fractions), then the long
// side to 1800 / 720. The original proportions are kept otherwise.
async function renderExternal(page, picture) {
  const parts = (await originals(picture)).map((file) => {
    const type = extname(file) === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${type};base64,${readFileSync(file).toString('base64')}`;
  });
  const result = await page.evaluate(
    async ({ parts, crop, longSide, quality, maxBytes, minQuality }) => {
      const images = await Promise.all(
        parts.map(async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          return img;
        }),
      );
      const height = Math.min(...images.map((img) => img.naturalHeight));
      const widths = images.map((img) => Math.round((img.naturalWidth * height) / img.naturalHeight));
      const joined = document.createElement('canvas');
      joined.width = widths.reduce((a, b) => a + b, 0);
      joined.height = height;
      let x = 0;
      images.forEach((img, i) => {
        joined.getContext('2d').drawImage(img, x, 0, widths[i], height);
        x += widths[i];
      });
      const [x0, y0, x1, y1] = crop ?? [0, 0, 1, 1];
      const sx = Math.round(x0 * joined.width);
      const sy = Math.round(y0 * joined.height);
      const sw = Math.round((x1 - x0) * joined.width);
      const sh = Math.round((y1 - y0) * joined.height);
      const out = {};
      for (const name of ['full', 'thumb']) {
        const k = longSide[name] / Math.max(sw, sh);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(sw * k);
        canvas.height = Math.round(sh * k);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(joined, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        let q = quality[name];
        let url = canvas.toDataURL('image/webp', q);
        if (!url.startsWith('data:image/webp')) throw new Error('this browser cannot encode WebP');
        const bytes = (u) => ((u.length - u.indexOf(',') - 1) * 3) / 4;
        while (bytes(url) > maxBytes[name] && q > minQuality + 1e-9) {
          q = Math.max(minQuality, q - 0.05);
          url = canvas.toDataURL('image/webp', q);
        }
        out[name] = { width: canvas.width, height: canvas.height, quality: q, data: url.slice(url.indexOf(',') + 1) };
      }
      return out;
    },
    {
      parts,
      crop: picture.crop ?? null,
      longSide: LONG_SIDE,
      quality: RASTER_QUALITY,
      maxBytes: MAX_BYTES,
      minQuality: RASTER_MIN_QUALITY,
    },
  );
  console.log(`${picture.key}: ${result.full.width}x${result.full.height} q${result.full.quality.toFixed(2)}`);
  writeFileSync(join(OUT, `${picture.key}.webp`), Buffer.from(result.full.data, 'base64'));
  writeFileSync(join(OUT, `${picture.key}-thumb.webp`), Buffer.from(result.thumb.data, 'base64'));
  const { images, crop, ...meta } = picture;
  return {
    key: meta.key,
    title: meta.title,
    category: meta.category,
    width: result.full.width,
    height: result.full.height,
    src: `/images/builtin/${meta.key}.webp`,
    thumb: `/images/builtin/${meta.key}-thumb.webp`,
    source: meta.source,
    license: meta.license,
    credit: meta.credit,
    year: meta.year,
    holder: meta.holder,
    ...(meta.note ? { note: meta.note } : {}),
  };
}
