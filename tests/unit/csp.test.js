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

// The only outside hosts the site may load from or talk to.
// accounts.google.com: Google sign-in (GIS, spec D15). Loaded only once the hosted Google
// client ID is set (T25); the CSP header lists it from T23.
const ALLOWED_HOSTS = ['cdn.jsdelivr.net', '*.supabase.co', 'accounts.google.com'];

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

  it('allows only this site, the CDN for supabase-js and Pretendard, and Supabase', () => {
    expect(directives['default-src']).toEqual(["'self'"]);
    // 'wasm-unsafe-eval' lets Safari compile the WebP encoder (WebAssembly only, no JS eval).
    expect(directives['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net']);
    expect(directives['style-src']).toEqual(["'self'", 'https://cdn.jsdelivr.net']);
    expect(directives['font-src']).toEqual(["'self'", 'https://cdn.jsdelivr.net']);
    // The WebP encoder and its .wasm are served from this site (js/vendor), not the CDN.
    expect(directives['connect-src']).toEqual(["'self'", 'https://*.supabase.co', 'wss://*.supabase.co']);
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https://*.supabase.co']);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
  });

  it('has no inline or eval escape hatches', () => {
    expect(csp).not.toMatch(/unsafe-inline|(?<!wasm-)unsafe-eval|unsafe-hashes|\*(?!\.supabase\.co)/);
  });

  it('the local server adds only the local stack: Supabase for connections and images, the rt server for connections', () => {
    const local = withLocalServers(csp, 'localhost:4173');
    expect(local).toContain(
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co http://127.0.0.1:56321 ws://127.0.0.1:56321 http://127.0.0.1:3400 ws://127.0.0.1:3400",
    );
    expect(local).toContain("img-src 'self' data: blob: https://*.supabase.co http://127.0.0.1:56321 ws://127.0.0.1:56321;");
    expect(local.replace(/ (http|ws):\/\/127\.0\.0\.1:(56321|3400)/g, '')).toBe(csp);
    // A tablet on the same Wi-Fi uses the LAN address for the stack as well.
    const lan = withLocalServers(csp, '192.168.0.12:4173');
    expect(lan).toContain('http://192.168.0.12:56321 ws://192.168.0.12:56321');
    expect(lan).toContain('http://192.168.0.12:3400 ws://192.168.0.12:3400');
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
