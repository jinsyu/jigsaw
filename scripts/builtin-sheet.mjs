// Dev tool: contact sheets of the built-in pictures (thumbnails with key, title and level), for
// looking at many pictures at once before and after `pnpm images:builtin`.
// Writes test-results/sheets/sheet-<n>.png (not in git), 48 pictures per sheet.
// Usage: pnpm images:sheet [word]   (word: only pictures whose key, title, kind or theme has it)
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PUBLIC = new URL('../public', import.meta.url).pathname;
const OUT = new URL('../test-results/sheets/', import.meta.url).pathname;
const PER_SHEET = 48;
const word = process.argv[2];
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const all = JSON.parse(readFileSync(`${PUBLIC}/images/builtin/index.json`, 'utf8')).images;
const images = word ? all.filter((i) => [i.key, i.title, i.category, i.topic, ...(i.tags ?? [])].join(' ').includes(word)) : all;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  for (let n = 0; n * PER_SHEET < images.length; n++) {
    const cells = images
      .slice(n * PER_SHEET, (n + 1) * PER_SHEET)
      .map((image) => {
        const data = readFileSync(`${PUBLIC}${image.thumb}`).toString('base64');
        return `<figure><img src="data:image/webp;base64,${data}"><figcaption>${escape(image.key)} · ${escape(image.title)} · ${escape(image.level ?? '')}</figcaption></figure>`;
      })
      .join('');
    await page.setContent(
      `<style>body{margin:6px;font:11px sans-serif;display:grid;grid-template-columns:repeat(8,1fr);gap:6px}figure{margin:0}img{width:100%;height:140px;object-fit:contain;background:#eee}</style>${cells}`,
    );
    const file = `${OUT}sheet-${n + 1}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
  }
} finally {
  await browser.close();
}
