// Renders the self-made mockup scenes (docs/mockups/src/common.js) into the built-in
// pictures: public/images/builtin/<key>.webp (1800 x 1200), <key>-thumb.webp (720 x 480)
// and index.json. Usage: pnpm images:builtin   (needs network for the Pretendard font)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public/images/builtin');
const SCENE_W = 600;
const SCENE_H = 400;
const FULL = { width: 1800, height: 1200, quality: 0.86 };
const THUMB = { width: 720, height: 480, quality: 0.8 };

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
];
const SOURCE = '함께 퍼즐 자체 제작';
const LICENSE = '함께 퍼즐 수업용으로 자유롭게 사용';

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: FULL.width, height: FULL.height } });
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
        let svg = window.M.SCENES[picture.scene].svg;
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
      { picture, sceneW: SCENE_W, sceneH: SCENE_H },
    );

    for (const [name, size] of Object.entries({ full: FULL, thumb: THUMB })) {
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
      category: picture.category,
      width: FULL.width,
      height: FULL.height,
      src: `/images/builtin/${picture.key}.webp`,
      thumb: `/images/builtin/${picture.key}-thumb.webp`,
      source: SOURCE,
      license: LICENSE,
    });
  }
  writeFileSync(join(OUT, 'index.json'), `${JSON.stringify({ version: 1, images: index }, null, 2)}\n`);
} finally {
  await browser.close();
}
console.log(`Wrote ${PICTURES.length} built-in pictures to public/images/builtin/`);
