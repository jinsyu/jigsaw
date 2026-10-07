import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { headersFor } from '../../scripts/lib/vercel-routing.mjs';
import { withLocalServers } from '../../scripts/lib/local-csp.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const csp = headersFor('/', config)['Content-Security-Policy'];
const directives = Object.fromEntries(
  csp.split('; ').map((part) => {
    const [name, ...values] = part.split(' ');
    return [name, values];
  }),
);

// The only outside hosts the site may load from or talk to (spec D15).
// accounts.google.com: Google sign-in (GIS). Loaded only once the hosted Google client ID is
// set (T25). rt.gyosil.app: written in config.js at T25 too. Teachers' pictures come from the
// Supabase Storage of the gyosil project through signed URLs the rt server hands out, so that
// host is never written in public/.
const ALLOWED_HOSTS = ['cdn.jsdelivr.net', 'accounts.google.com', 'rt.gyosil.app'];
const STORAGE = 'https://ozfzpyumnaaggrlevygz.supabase.co/storage/v1/object/sign/jigsaw-images/';

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}
const publicFiles = filesUnder(join(ROOT, 'public')).filter((f) => ['.html', '.js', '.css', '.json', '.webmanifest'].includes(extname(f)));

describe('Content-Security-Policy (vercel.json)', () => {
  it('applies to every page and file', () => {
    for (const path of ['/', '/privacy', '/play', '/teacher/new', '/js/app.js', '/images/builtin/sea.webp']) {
      expect(headersFor(path, config)['Content-Security-Policy']).toBe(csp);
    }
  });

  it('allows only this site, the rt server, Google sign-in, signed picture URLs and the Pretendard font', () => {
    expect(directives['default-src']).toEqual(["'self'"]);
    // 'wasm-unsafe-eval' lets Safari compile the WebP encoder (WebAssembly only, no JS eval).
    // The only outside script is GIS; no script comes from jsDelivr any more.
    expect(directives['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'", 'https://accounts.google.com/gsi/client']);
    // jsDelivr: the Pretendard CSS and font files only (style-src, font-src).
    expect(directives['style-src']).toEqual(["'self'", 'https://cdn.jsdelivr.net', 'https://accounts.google.com/gsi/style']);
    expect(directives['font-src']).toEqual(["'self'", 'https://cdn.jsdelivr.net']);
    // The WebP encoder and its .wasm are served from this site (js/vendor), not a CDN.
    expect(directives['connect-src']).toEqual(["'self'", 'https://rt.gyosil.app', 'wss://rt.gyosil.app', STORAGE, 'https://accounts.google.com/gsi/']);
    // Teachers' pictures: <img> / SVG <image> of a signed URL, and fetch() into a blob: URL.
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:', STORAGE]);
    expect(directives['frame-src']).toEqual(['https://accounts.google.com/gsi/']);
    expect(directives['worker-src']).toEqual(["'self'", 'blob:']);
    expect(directives['manifest-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
    expect(directives['form-action']).toEqual(["'self'"]);
    expect(Object.keys(directives).sort()).toEqual(
      ['base-uri', 'connect-src', 'default-src', 'font-src', 'form-action', 'frame-ancestors', 'frame-src', 'img-src', 'manifest-src', 'object-src', 'script-src', 'style-src', 'worker-src'],
    );
  });

  it('every outside address in the header is on the allowed list (D15), and no local address', () => {
    const hosts = new Set(
      Object.values(directives)
        .flat()
        .filter((v) => /^(https?|wss?):\/\//.test(v))
        .map((v) => new URL(v.replace(/^wss:/, 'https:')).hostname),
    );
    expect([...hosts].sort()).toEqual(['accounts.google.com', 'cdn.jsdelivr.net', 'ozfzpyumnaaggrlevygz.supabase.co', 'rt.gyosil.app']);
    expect(csp).not.toMatch(/localhost|127\.0\.0\.1|http:|ws:/);
  });

  it('has no inline or eval escape hatches and no wildcard', () => {
    expect(csp).not.toMatch(/unsafe-inline|(?<!wasm-)unsafe-eval|unsafe-hashes|\*/);
  });

  it('the local server adds only the local stack: the rt server, and signed picture URLs of the local Storage', () => {
    const local = withLocalServers(csp, 'localhost:4173');
    const pictures = 'http://127.0.0.1:56321/storage/v1/object/sign/jigsaw-images/';
    expect(local).toContain(
      `connect-src 'self' https://rt.gyosil.app wss://rt.gyosil.app ${STORAGE} https://accounts.google.com/gsi/ http://127.0.0.1:3400 ws://127.0.0.1:3400 ${pictures};`,
    );
    expect(local).toContain(`img-src 'self' data: blob: ${STORAGE} ${pictures};`);
    expect(local.replace(/ (http|ws):\/\/127\.0\.0\.1:(56321|3400)[^ ;]*/g, '')).toBe(csp);
    // A tablet on the same Wi-Fi uses the LAN address for the stack as well.
    const lan = withLocalServers(csp, '192.168.0.12:4173');
    expect(lan).toContain('http://192.168.0.12:56321/storage/v1/object/sign/jigsaw-images/');
    expect(lan).toContain('http://192.168.0.12:3400 ws://192.168.0.12:3400');
    expect(lan).not.toContain('ws://192.168.0.12:56321');
  });
});

describe('no ads or outside analytics (public/)', () => {
  const BANNED = [
    /googletagmanager|google-analytics|gtag\(|\bga\(/i,
    /doubleclick|googlesyndication|adsbygoogle|adservice/i,
    /connect\.facebook\.net|fbq\(/i,
    /hotjar|clarity\.ms|mixpanel|amplitude|segment\.(io|com)|plausible|umami|matomo|posthog|sentry/i,
    /wcs\.naver|wcslog|kakao.*(pixel|ad)/i,
  ];

  it.each(publicFiles.map((f) => [relative(ROOT, f), f]))('%s has no ad or analytics code', (_, file) => {
    const text = readFileSync(file, 'utf8');
    for (const pattern of BANNED) expect(text).not.toMatch(pattern);
  });

  it('every outside address the pages load is on the allowed list', () => {
    const outside = new Set();
    for (const file of publicFiles) {
      if (file.includes(`${join('js', 'vendor')}`)) continue; // licence comments only, checked above
      const text = readFileSync(file, 'utf8');
      // What a page loads: src attributes, <link href> (styles, preconnect), CSS url() /
      // @import, and string literals in code. Plain <a href> links only navigate.
      const found = [
        ...text.matchAll(/src="(https?:\/\/[^"]+)"/g),
        ...text.matchAll(/<link\b[^>]*\bhref="(https?:\/\/[^"]+)"/g),
        ...text.matchAll(/url\(["']?(https?:\/\/[^)"']+)/g),
        ...text.matchAll(/['`](https?:\/\/[^'`$]+)['`]/g),
      ].map((m) => new URL(m[1]).hostname);
      for (const host of found) outside.add(host);
    }
    // Canonical links of this site, and the SVG namespace name (never fetched).
    const notLoaded = ['jigsaw.gyosil.app', 'www.w3.org'];
    const unexpected = [...outside].filter((h) => !notLoaded.includes(h) && !ALLOWED_HOSTS.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a)));
    expect(unexpected).toEqual([]);
  });
});
