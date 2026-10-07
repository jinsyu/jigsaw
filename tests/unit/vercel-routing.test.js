import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { headersFor, resolveRequest, sourceToRegExp } from '../../scripts/lib/vercel-routing.mjs';
import { matchRoute } from '../../public/js/routes.js';

const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
const files = new Set(['/index.html', '/privacy.html', '/css/base.css', '/robots.txt']);
const isFile = (p) => files.has(p);

describe('sourceToRegExp', () => {
  it('matches named, wildcard and raw group segments', () => {
    expect(sourceToRegExp('/teacher/:path*').test('/teacher')).toBe(true);
    expect(sourceToRegExp('/teacher/:path*').test('/teacher/a/b')).toBe(true);
    expect(sourceToRegExp('/teacher/:path*').test('/teachers')).toBe(false);
    expect(sourceToRegExp('/s/:id').test('/s/12')).toBe(true);
    expect(sourceToRegExp('/s/:id').test('/s/12/x')).toBe(false);
    expect(sourceToRegExp('/(.*)').test('/anything/here')).toBe(true);
  });
});

describe('resolveRequest with vercel.json', () => {
  it.each([
    ['/', { type: 'file', path: '/index.html' }],
    ['/css/base.css', { type: 'file', path: '/css/base.css' }],
    ['/privacy', { type: 'file', path: '/privacy.html' }],
    ['/privacy.html', { type: 'redirect', location: '/privacy' }],
    ['/index.html', { type: 'redirect', location: '/' }],
    ['/join', { type: 'file', path: '/index.html' }],
    ['/play', { type: 'file', path: '/index.html' }],
    ['/teacher', { type: 'file', path: '/index.html' }],
    ['/teacher/new', { type: 'file', path: '/index.html' }],
    ['/supabase/migrations/x.sql', { type: 'notFound' }],
    ['/nope', { type: 'notFound' }],
  ])('%s', (path, expected) => {
    expect(resolveRequest(path, config, isFile)).toEqual(expected);
  });

  it('resolves rewrite destinations with cleanUrls rules', () => {
    const withDest = (destination) => ({ ...config, rewrites: [{ source: '/join', destination }] });
    expect(resolveRequest('/join', withDest('/'), isFile)).toEqual({ type: 'file', path: '/index.html' });
    expect(resolveRequest('/join', withDest('/index'), isFile)).toEqual({ type: 'file', path: '/index.html' });
    // Vercel does not serve ".html" destinations when cleanUrls is on.
    expect(resolveRequest('/join', withDest('/index.html'), isFile)).toEqual({ type: 'notFound' });
  });

  it('vercel.json rewrite destinations do not end in .html while cleanUrls is on', () => {
    expect(config.cleanUrls).toBe(true);
    for (const rule of config.rewrites) expect(rule.destination).not.toMatch(/\.html$/);
  });

  it('every rewritten screen path is a known app route', () => {
    for (const path of ['/join', '/play', '/teacher', '/teacher/new']) {
      expect(matchRoute(path)).not.toBe('notFound');
    }
  });

  it('applies security headers to every path', () => {
    const headers = headersFor('/teacher/new', config);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBeTruthy();
  });
});
