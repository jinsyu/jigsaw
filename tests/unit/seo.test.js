import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SITE = 'https://jigsaw.gyosil.app';
const read = (p) => readFileSync(new URL(`../../public/${p}`, import.meta.url), 'utf8');
const PAGES = [
  { file: 'index.html', url: `${SITE}/` },
  { file: 'privacy.html', url: `${SITE}/privacy` },
];

describe('public pages metadata', () => {
  it.each(PAGES)('$file has lang, title, description, canonical and OG', ({ file, url }) => {
    const html = read(file);
    expect(html).toContain('<html lang="ko">');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    const description = html.match(/<meta name="description" content="([^"]+)">/)?.[1] ?? '';
    expect(description.length).toBeGreaterThanOrEqual(60);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(html).toContain(`<link rel="canonical" href="${url}">`);
    expect(html).toContain(`<meta property="og:url" content="${url}">`);
    expect(html).toContain(`<meta property="og:image" content="${SITE}/og.png">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it('sitemap lists exactly the public pages', () => {
    const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(PAGES.map((p) => p.url));
  });

  it('robots points to the sitemap and hides app screens', () => {
    const robots = read('robots.txt');
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    for (const path of ['/teacher', '/join', '/play']) expect(robots).toContain(`Disallow: ${path}`);
  });
});
