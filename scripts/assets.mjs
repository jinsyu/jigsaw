// Generates icon.svg, hero.svg, favicon PNGs and og.png from the mockup puzzle shapes.
// Usage: pnpm assets   (needs network for the Pretendard font used by og.html)
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const BRAND = '#3F5BD9';
const HERO_COLORS = ['#F0544F', '#22A559', '#3B82F6', '#F2A20C'];
const ICON_BG = '#FBF7F0';

const withXmlns = (svg) => svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addScriptTag({ path: join(ROOT, 'docs/mockups/src/common.js') });
  const { icon, hero } = await page.evaluate(
    ([brand, colors]) => ({ icon: window.M.iconPiece(brand), hero: window.M.colorPieces(2, 2, 3, colors) }),
    [BRAND, HERO_COLORS],
  );
  writeFileSync(join(PUBLIC, 'icon.svg'), withXmlns(icon) + '\n');
  writeFileSync(join(PUBLIC, 'images/hero.svg'), withXmlns(hero) + '\n');

  // setContent pages cannot load file:// URLs, so inline the SVG as a data URL.
  const iconUrl = `data:image/svg+xml;base64,${Buffer.from(withXmlns(icon)).toString('base64')}`;
  async function renderIcon(size, padding, background) {
    const p = await browser.newPage({ viewport: { width: size, height: size } });
    await p.setContent(
      `<body style="margin:0;background:${background}"><img src="${iconUrl}" style="display:block;box-sizing:border-box;width:${size}px;height:${size}px;padding:${padding}px"></body>`,
    );
    await p.waitForFunction(() => document.querySelector('img').complete);
    const png = await p.screenshot({ omitBackground: background === 'transparent' });
    await p.close();
    return png;
  }
  writeFileSync(join(PUBLIC, 'favicon-32.png'), await renderIcon(32, 0, 'transparent'));
  writeFileSync(join(PUBLIC, 'apple-touch-icon.png'), await renderIcon(180, 26, ICON_BG));

  const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await og.goto(pathToFileURL(join(ROOT, 'scripts/og.html')).href, { waitUntil: 'networkidle' });
  await og.evaluate(() => document.fonts.ready);
  writeFileSync(join(PUBLIC, 'og.png'), await og.screenshot());
} finally {
  await browser.close();
}
console.log('Wrote icon.svg, images/hero.svg, favicon-32.png, apple-touch-icon.png, og.png');
