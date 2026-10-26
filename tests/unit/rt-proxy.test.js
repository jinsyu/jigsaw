// middleware.js: this site's /rt in front of the rt server (schools that block its address).
import { afterEach, describe, expect, it, vi } from 'vitest';
import middleware, { config } from '../../middleware.js';

// What Vercel does with the answer: the URL it fetches and the request headers it sends there.
function upstream(response) {
  const kept = response.headers.get('x-middleware-override-headers').split(',');
  const headers = Object.fromEntries(kept.map((name) => [name, response.headers.get(`x-middleware-request-${name}`)]));
  return { url: response.headers.get('x-middleware-rewrite'), headers };
}

function request(path, headers = {}) {
  return new Request(`https://jigsaw-gyosil.vercel.app${path}`, { headers: { 'x-real-ip': '203.0.113.9', ...headers } });
}

const SECRET = 'p'.repeat(48);

describe('/rt (middleware.js)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('runs only on /rt', () => {
    expect(config).toEqual({ matcher: '/rt/:path*', runtime: 'nodejs' });
  });

  it('passes /rt/X on to the rt address as X with its query, and /rt/socket.io as /socket.io/', () => {
    expect(upstream(middleware(request('/rt/api/join?x=1'))).url).toBe('https://jigsaw-rt.gyosil.app/api/join?x=1');
    expect(upstream(middleware(request('/rt/health'))).url).toBe('https://jigsaw-rt.gyosil.app/health');
    expect(upstream(middleware(request('/rt/socket.io?EIO=4&transport=polling&t=abc'))).url).toBe(
      'https://jigsaw-rt.gyosil.app/socket.io/?EIO=4&transport=polling&t=abc',
    );
  });

  it("gives a request without Origin this site's, keeps any other, and keeps this site's cookies here", () => {
    const sameOrigin = upstream(middleware(request('/rt/socket.io?EIO=4', { cookie: 'a=1', authorization: 'Bearer t' })));
    expect(sameOrigin.headers.origin).toBe('https://jigsaw-gyosil.vercel.app');
    expect(sameOrigin.headers.cookie).toBeUndefined();
    expect(sameOrigin.headers.authorization).toBe('Bearer t');
    const other = upstream(middleware(request('/rt/api/join', { origin: 'https://evil.example' })));
    expect(other.headers.origin).toBe('https://evil.example');
  });

  it('sends the client address with RT_PROXY_SECRET, and never a forged one', () => {
    vi.stubEnv('RT_PROXY_SECRET', SECRET);
    const forged = { 'x-jigsaw-proxy': 'forged', 'x-jigsaw-client': '198.51.100.1' };
    const { headers } = upstream(middleware(request('/rt/api/join', forged)));
    expect(headers['x-jigsaw-proxy']).toBe(SECRET);
    expect(headers['x-jigsaw-client']).toBe('203.0.113.9');
  });

  it('sends neither header without RT_PROXY_SECRET, and drops forged ones', () => {
    vi.stubEnv('RT_PROXY_SECRET', '');
    const { headers } = upstream(middleware(request('/rt/api/join', { 'x-jigsaw-proxy': SECRET, 'x-jigsaw-client': '198.51.100.1' })));
    expect(headers['x-jigsaw-proxy']).toBeUndefined();
    expect(headers['x-jigsaw-client']).toBeUndefined();
  });

  it('goes to RT_PROXY_TARGET instead when it is set (local runs)', () => {
    vi.stubEnv('RT_PROXY_TARGET', 'http://127.0.0.1:5401/');
    expect(upstream(middleware(request('/rt/socket.io?EIO=4'))).url).toBe('http://127.0.0.1:5401/socket.io/?EIO=4');
  });
});
