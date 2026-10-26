import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtError, openSocket, rtRequest, rtRoute } from '../../public/js/rt-client.js';

function fakeFetch(status, body, seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => (body === undefined ? Promise.reject(new Error('no json')) : body) };
  };
}

describe('rtRequest', () => {
  it('sends JSON with the teacher token and returns the answer', async () => {
    const seen = [];
    const answer = await rtRequest('http://127.0.0.1:3400', '/api/sessions', {
      method: 'POST',
      token: 'tok',
      json: { pieceCount: 24 },
      fetchImpl: fakeFetch(200, { ok: true, sessionId: 's1', code: '123456' }, seen),
    });
    expect(answer).toEqual({ ok: true, sessionId: 's1', code: '123456' });
    expect(seen[0].url).toBe('http://127.0.0.1:3400/api/sessions');
    expect(seen[0].init).toMatchObject({ method: 'POST', credentials: 'omit', body: '{"pieceCount":24}' });
    expect(seen[0].init.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' });
  });

  it('sends raw bytes with their type (picture upload)', async () => {
    const seen = [];
    const body = new Uint8Array([1, 2, 3]);
    await rtRequest('http://rt', '/api/images', { method: 'POST', body, contentType: 'image/webp', fetchImpl: fakeFetch(200, { ok: true }, seen) });
    expect(seen[0].init.body).toBe(body);
    expect(seen[0].init.headers).toEqual({ 'content-type': 'image/webp' });
  });

  it("turns a refusal into RtError with the server's error name", async () => {
    const error = await rtRequest('http://rt', '/api/images/x', { method: 'DELETE', fetchImpl: fakeFetch(409, { ok: false, error: 'image_in_use' }) }).catch((e) => e);
    expect(error).toBeInstanceOf(RtError);
    expect(error).toMatchObject({ code: 'image_in_use', status: 409, network: false });
  });

  it('names a failure without a readable answer server_error, and an unreachable server network', async () => {
    const broken = await rtRequest('http://rt', '/api/sessions', { fetchImpl: fakeFetch(502, undefined) }).catch((e) => e);
    expect(broken).toMatchObject({ code: 'server_error', status: 502 });
    const offline = await rtRequest('http://rt', '/api/sessions', {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    }).catch((e) => e);
    expect(offline).toMatchObject({ code: 'network', network: true });
  });
});

const IP_HEALTH = 'https://13.124.90.119/jigsaw/health';

// A fetch for the two /health looks: urls that answer resolve, `pending` ones never settle, the
// rest fail like a blocked address.
function probes({ open = [], pending = [] } = {}) {
  return vi.fn((url) => {
    if (open.some((u) => url.startsWith(u))) return Promise.resolve({ ok: false, status: 0 });
    if (pending.some((u) => url.startsWith(u))) return new Promise(() => {});
    return Promise.reject(new TypeError('Failed to fetch'));
  });
}

describe('rtRoute (schools that block the rt address)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const site = (origin = 'https://jigsaw-gyosil.vercel.app') => vi.stubGlobal('location', { origin });
  const PROXIED = { http: 'https://jigsaw-gyosil.vercel.app/rt', socketUrl: 'https://jigsaw-gyosil.vercel.app', socketPath: '/rt/socket.io', pollingOnly: true };
  const BY_IP = { http: 'https://13.124.90.119/jigsaw', socketUrl: 'https://13.124.90.119', socketPath: '/jigsaw/socket.io', pollingOnly: false };

  it('goes straight to an rt address that answers, after one look at /health', async () => {
    site();
    const answers = probes({ open: ['https://open.rt.test', IP_HEALTH] });
    vi.stubGlobal('fetch', answers);
    expect(await rtRoute('https://open.rt.test')).toEqual({
      http: 'https://open.rt.test',
      socketUrl: 'https://open.rt.test',
      socketPath: '/socket.io/',
      pollingOnly: false,
    });
    expect(answers).toHaveBeenCalledWith('https://open.rt.test/health', expect.objectContaining({ mode: 'no-cors', cache: 'no-store' }));
    expect(answers.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('looks at the rt address and the IP address at once, with the same options', async () => {
    site();
    const answers = probes({ pending: ['https://both.rt.test', IP_HEALTH] });
    vi.stubGlobal('fetch', answers);
    rtRoute('https://both.rt.test');
    await Promise.resolve();
    expect(answers.mock.calls.map(([url]) => url)).toEqual(['https://both.rt.test/health', IP_HEALTH]);
    for (const [, init] of answers.mock.calls) {
      expect(init).toMatchObject({ mode: 'no-cors', cache: 'no-store' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('does not wait for the IP address when the rt address answers', async () => {
    site();
    vi.stubGlobal('fetch', probes({ open: ['https://fast.rt.test'], pending: [IP_HEALTH] }));
    expect((await rtRoute('https://fast.rt.test')).socketUrl).toBe('https://fast.rt.test');
  });

  it('goes to the IP address with WebSocket when only the rt address is blocked, looking once per page', async () => {
    site();
    const answers = probes({ open: [IP_HEALTH] });
    vi.stubGlobal('fetch', answers);
    expect(await rtRoute('https://name-blocked.rt.test')).toEqual(BY_IP);
    expect(await rtRoute('https://name-blocked.rt.test')).toEqual(BY_IP);
    expect(answers).toHaveBeenCalledTimes(2);
  });

  it("goes through this site's /rt on polling when neither address answers, looking once per page", async () => {
    site();
    const blocked = probes();
    vi.stubGlobal('fetch', blocked);
    expect(await rtRoute('https://blocked.rt.test')).toEqual(PROXIED);
    expect(await rtRoute('https://blocked.rt.test')).toEqual(PROXIED);
    expect(blocked.mock.calls.map(([url]) => url)).toEqual(['https://blocked.rt.test/health', IP_HEALTH]);
  });

  it('never looks for a local rt server, nor outside a browser', async () => {
    const never = vi.fn();
    vi.stubGlobal('fetch', never);
    expect((await rtRoute('http://localhost:3400')).pollingOnly).toBe(false);
    site('http://192.168.0.5:4173');
    for (const url of ['http://127.0.0.1:3400', 'http://192.168.0.5:3400', 'http://jigsaw.local:3400']) {
      expect(await rtRoute(url)).toMatchObject({ http: url, socketUrl: url, socketPath: '/socket.io/' });
    }
    expect(never).not.toHaveBeenCalled();
  });

  it('sends requests to the IP address with the same options when only the rt address is blocked', async () => {
    site();
    vi.stubGlobal('fetch', probes({ open: [IP_HEALTH] }));
    const seen = [];
    await rtRequest('https://name-blocked2.rt.test', '/api/join', { method: 'POST', json: { code: '1' }, fetchImpl: fakeFetch(200, { ok: true }, seen) });
    expect(seen[0].url).toBe('https://13.124.90.119/jigsaw/api/join');
    expect(seen[0].init).toMatchObject({ method: 'POST', mode: 'cors', credentials: 'omit' });
  });

  it("sends requests through /rt with the same options when neither address answers", async () => {
    site();
    vi.stubGlobal('fetch', probes());
    const seen = [];
    await rtRequest('https://blocked2.rt.test', '/api/join', { method: 'POST', json: { code: '1' }, fetchImpl: fakeFetch(200, { ok: true }, seen) });
    expect(seen[0].url).toBe('https://jigsaw-gyosil.vercel.app/rt/api/join');
    expect(seen[0].init).toMatchObject({ method: 'POST', mode: 'cors', credentials: 'omit' });
  });
});

describe('openSocket', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The real pinned socket.io-client; the URL is what the first polling request asks for.
  async function firstRequest(rtUrl) {
    const socket = await openSocket(rtUrl, { role: 'student', token: 't' });
    const { opts } = socket.io;
    const uri = socket.io.engine.transport.uri();
    socket.disconnect();
    return { opts, uri };
  }

  it('connects straight with the same options and URL as before /rt', async () => {
    vi.stubGlobal('location', { origin: 'https://jigsaw-gyosil.vercel.app' });
    vi.stubGlobal('fetch', probes({ open: ['https://open-socket.rt.test', IP_HEALTH] }));
    const { opts, uri } = await firstRequest('https://open-socket.rt.test');
    expect(opts).toMatchObject({ path: '/socket.io/', withCredentials: false, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    expect(opts.transports).toBeUndefined();
    expect(opts.addTrailingSlash).toBeUndefined();
    expect(uri).toMatch(/^https:\/\/open-socket\.rt\.test\/socket\.io\/\?EIO=4&transport=polling&t=/);
  });

  it('connects to the IP address at /jigsaw/socket.io/ (path /jigsaw/socket.io) with WebSocket allowed when only the rt address is blocked', async () => {
    vi.stubGlobal('location', { origin: 'https://jigsaw-gyosil.vercel.app' });
    vi.stubGlobal('fetch', probes({ open: [IP_HEALTH] }));
    const { opts, uri } = await firstRequest('https://name-blocked-socket.rt.test');
    expect(opts).toMatchObject({ path: '/jigsaw/socket.io', withCredentials: false, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    // socket.io's defaults: polling first, then the WebSocket upgrade; the trailing slash added back.
    expect(opts.transports).toBeUndefined();
    expect(opts.addTrailingSlash).toBeUndefined();
    expect(uri).toMatch(/^https:\/\/13\.124\.90\.119\/jigsaw\/socket\.io\/\?EIO=4&transport=polling&t=/);
  });

  it("connects through this site's /rt/socket.io on polling only when neither address answers", async () => {
    vi.stubGlobal('location', { origin: 'https://jigsaw-gyosil.vercel.app' });
    vi.stubGlobal('fetch', probes());
    const { opts, uri } = await firstRequest('https://blocked-socket.rt.test');
    expect(opts).toMatchObject({ transports: ['polling'], addTrailingSlash: false, withCredentials: false });
    expect(uri).toMatch(/^https:\/\/jigsaw-gyosil\.vercel\.app\/rt\/socket\.io\?EIO=4&transport=polling&t=/);
  });
});
