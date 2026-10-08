// Builds the built-in pictures from scripts/builtin-external.json (public domain, CC0,
// 공공누리 제1유형): downloads the originals into BUILTIN_ORIGINALS (default: the OS temp folder,
// never the repository), crops or joins them as recorded there, and resizes them.
// Writes public/images/builtin/<key>.webp (long side 1800, less if the file would be too big),
// <key>-thumb.webp (long side 720)
// and index.json (in the order of the JSON file). Usage: pnpm images:builtin   (needs network)
// Sources, licences and checks: docs/image-candidates.md.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { withCredits } from './lib/privacy-credits.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public/images/builtin');
const LONG_SIDE = { full: 1800, thumb: 720 }; // pictures keep their own proportions
const RASTER_QUALITY = { full: 0.8, thumb: 0.78 };
// Whole classes load a picture at once on school Wi-Fi: keep files under these sizes
// (the encoder quality steps down until they fit, but not below RASTER_MIN_QUALITY; then the
// picture is made smaller, long side down to 70%).
const MAX_BYTES = { full: 500_000, thumb: 80_000 };
const RASTER_MIN_QUALITY = 0.5;
const EXTERNAL = JSON.parse(readFileSync(join(ROOT, 'scripts/builtin-external.json'), 'utf8'));
const ORIGINALS = process.env.BUILTIN_ORIGINALS ?? join(tmpdir(), 'jigsaw-builtin-originals');
const USER_AGENT = 'JigsawClassroomBot/0.1 (educational puzzle; contact jinsyu.com@gmail.com)';

// index.json image entry:
//   { key, title, category, topic, level, width, height, src, thumb,
//     source:  { name, author, url },   who made it and where it came from
//     license: { name, url },           what may be done with it
//     credit,                           one line to show: 작품명, 작가, 연도 — 소장처 / 이미지, 라이선스
//     year, holder, note? }             when, who keeps it, what was changed
// category: 사진 | 삽화 | 명화 | 우리 그림. topic: what it shows (동물, 자연, ...).
// level: 쉬움 | 보통 | 어려움 (how hard it is to put together).
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1800 } });
  await page.setContent('<p>encoder</p>');
  const index = [];
  for (const picture of EXTERNAL) index.push(await renderExternal(page, picture));
  writeFileSync(join(OUT, 'index.json'), `${JSON.stringify({ version: 1, images: index }, null, 2)}\n`);
  // The privacy page names the source of every outside picture: keep it in step.
  const privacy = join(ROOT, 'public/privacy.html');
  writeFileSync(privacy, withCredits(readFileSync(privacy, 'utf8'), index));
} finally {
  await browser.close();
}
console.log(`Wrote ${EXTERNAL.length} built-in pictures to public/images/builtin/`);

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
      const bytes = (u) => ((u.length - u.indexOf(',') - 1) * 3) / 4;
      for (const name of ['full', 'thumb']) {
        // Quality steps down to minQuality; a picture still too big is drawn 10% smaller.
        for (const scale of [1, 0.9, 0.8, 0.7]) {
          const k = (longSide[name] * scale) / Math.max(sw, sh);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(sw * k);
          canvas.height = Math.round(sh * k);
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(joined, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          let q = quality[name];
          let url = canvas.toDataURL('image/webp', q);
          if (!url.startsWith('data:image/webp')) throw new Error('this browser cannot encode WebP');
          while (bytes(url) > maxBytes[name] && q > minQuality + 1e-9) {
            q = Math.max(minQuality, q - 0.05);
            url = canvas.toDataURL('image/webp', q);
          }
          out[name] = { width: canvas.width, height: canvas.height, quality: q, data: url.slice(url.indexOf(',') + 1) };
          if (bytes(url) <= maxBytes[name]) break;
        }
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
    topic: meta.topic,
    level: meta.level,
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
