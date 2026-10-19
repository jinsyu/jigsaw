import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// public/licenses.html (plan P1) is hand-written static HTML; these checks keep it in step with
// what the site and the rt server really ship: the Pretendard version the pages load, the
// vendor files recorded in public/js/vendor/LICENSES.md, and server/package.json.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('public/licenses.html');
const vendorNotice = read('public/js/vendor/LICENSES.md');

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const flat = (s) => s.replace(/\s+/g, ' ').trim();

/** Entries of the page: <li data-name data-version data-license> with their holder spans. */
function entriesIn(sectionId) {
  const section = html.match(new RegExp(`<section aria-labelledby="${sectionId}">([\\s\\S]*?)</section>`))?.[1] ?? '';
  return [...section.matchAll(/<li data-name="([^"]+)" data-version="([^"]+)" data-license="([^"]+)">([\s\S]*?)<\/li>/g)].map(
    ([, name, version, license, body]) => ({
      name,
      version,
      license,
      body,
      holders: [...body.matchAll(/<span class="lic-holder">([^<]+)<\/span>/g)].map((m) => decode(m[1])),
    }),
  );
}

/** "## qrcode-generator 2.0.4" and "## @jsquash/webp 1.5.0 (WebP encoder only)" headings. */
const vendorSections = [...vendorNotice.matchAll(/^## (\S+) (\d+\.\d+\.\d+)[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map(
  ([, name, version, body]) => ({ name, version, body }),
);

describe('fonts', () => {
  const [font] = entriesIn('fonts');

  it('lists the Pretendard version every page loads', () => {
    for (const page of ['public/index.html', 'public/privacy.html', 'public/licenses.html']) {
      expect(read(page)).toContain(`orioncactus/pretendard@v${font.version}/`);
    }
    expect(font).toMatchObject({ name: 'Pretendard', license: 'OFL-1.1' });
  });

  it('shows the OFL copyright notice and the full license text (OFL condition 2)', () => {
    const text = flat(decode(html.match(/<pre id="ofl-pretendard">([\s\S]*?)<\/pre>/)?.[1] ?? ''));
    expect(text.startsWith(flat(font.holders[0]))).toBe(true);
    expect(text).toContain('with Reserved Font Name Pretendard');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    for (const heading of ['PREAMBLE', 'DEFINITIONS', 'PERMISSION & CONDITIONS', 'TERMINATION', 'DISCLAIMER']) {
      expect(text).toContain(heading);
    }
    expect(text.endsWith('OTHER DEALINGS IN THE FONT SOFTWARE.')).toBe(true);
  });
});

describe('screen code (public/js/vendor)', () => {
  const listed = entriesIn('web');

  it('lists exactly the components of LICENSES.md, with the same versions', () => {
    const key = (e) => `${e.name}@${e.version}`;
    expect(listed.map(key).sort()).toEqual(vendorSections.map(key).sort());
  });

  it.each(vendorSections.map((s) => [s.name, s]))('%s: same license and copyright holders as LICENSES.md', (name, section) => {
    const entry = listed.find((e) => e.name === name);
    const license = section.body.match(/^- License: (MIT|Apache License 2\.0)/m)?.[1];
    expect(entry.license).toBe(license === 'MIT' ? 'MIT' : 'Apache-2.0');
    expect(entry.holders.length).toBeGreaterThan(0);
    for (const holder of entry.holders) expect(section.body).toContain(holder);
  });

  it('links the Apache 2.0 text kept next to the code, and the vendor notice', () => {
    expect(html).toContain('href="/js/vendor/LICENSE-Apache-2.0.txt"');
    expect(html).toContain('href="/js/vendor/LICENSES.md"');
  });

  it('carries the QR Code trademark notice', () => {
    expect(vendorNotice).toContain('The word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.');
    expect(html).toContain('QR Code는 DENSO WAVE INCORPORATED의 등록 상표입니다.');
  });
});

describe('rt server dependencies (server/package.json)', () => {
  const listed = entriesIn('server');
  const dependencies = JSON.parse(read('server/package.json')).dependencies;

  it('lists exactly the server dependencies at their pinned versions', () => {
    const fromPage = Object.fromEntries(listed.map((e) => [e.name, e.version]));
    expect(fromPage).toEqual(dependencies);
  });

  it.each(Object.keys(dependencies))('%s: license and copyright holder match node_modules', (name) => {
    const dir = join(ROOT, 'server/node_modules', name);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const licenseFile = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    const entry = listed.find((e) => e.name === name);
    expect(manifest.version).toBe(entry.version);
    expect(manifest.license).toBe(entry.license);
    const licenseText = readFileSync(join(dir, licenseFile), 'utf8');
    for (const holder of entry.holders) expect(licenseText).toContain(holder);
  });
});

describe('licenses page', () => {
  it('sends readers to the built-in picture credits instead of repeating them', () => {
    expect(html).toContain('href="/privacy#pictures"');
    expect(read('public/privacy.html')).toContain('<h2 id="pictures">');
  });

  it('names only the operator and the shared contact address', () => {
    expect(html).toContain('운영자');
    const emails = [...html.matchAll(/mailto:([^"]+)/g)].map((m) => m[1]);
    expect(new Set(emails)).toEqual(new Set(['gyosil.app@gmail.com']));
    expect(html).not.toMatch(/jinsyu/i);
  });

  it('is linked from the home page footer', () => {
    const footer = read('public/index.html').match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(footer).toContain('<a href="/licenses">라이선스</a>');
  });
});
