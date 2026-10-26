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

describe('rtRoute (schools that block the rt address)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const site = (origin = 'https://jigsaw-gyosil.vercel.app') => vi.stubGlobal('location', { origin });

  it('goes straight to an rt address that answers, after one look at /health', async () => {
    site();
    const answers = vi.fn(async () => ({ ok: false, status: 0 }));
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

  it("goes through this site's /rt on polling when the rt address does not answer, looking once per page", async () => {
    site();
    const blocked = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', blocked);
    const proxied = { http: 'https://jigsaw-gyosil.vercel.app/rt', socketUrl: 'https://jigsaw-gyosil.vercel.app', socketPath: '/rt/socket.io', pollingOnly: true };
    expect(await rtRoute('https://blocked.rt.test')).toEqual(proxied);
    expect(await rtRoute('https://blocked.rt.test')).toEqual(proxied);
    expect(blocked).toHaveBeenCalledTimes(1);
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

  it("sends requests through /rt with the same options when the rt address does not answer", async () => {
    site();
    vi.stubGlobal('fetch', async () => Promise.reject(new TypeError('Failed to fetch')));
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
    vi.stubGlobal('fetch', async () => ({ ok: true }));
    const { opts, uri } = await firstRequest('https://open-socket.rt.test');
    expect(opts).toMatchObject({ path: '/socket.io/', withCredentials: false, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    expect(opts.transports).toBeUndefined();
    expect(opts.addTrailingSlash).toBeUndefined();
    expect(uri).toMatch(/^https:\/\/open-socket\.rt\.test\/socket\.io\/\?EIO=4&transport=polling&t=/);
  });

  it("connects through this site's /rt/socket.io on polling only when the rt address does not answer", async () => {
    vi.stubGlobal('location', { origin: 'https://jigsaw-gyosil.vercel.app' });
    vi.stubGlobal('fetch', async () => Promise.reject(new TypeError('Failed to fetch')));
    const { opts, uri } = await firstRequest('https://blocked-socket.rt.test');
    expect(opts).toMatchObject({ transports: ['polling'], addTrailingSlash: false, withCredentials: false });
    expect(uri).toMatch(/^https:\/\/jigsaw-gyosil\.vercel\.app\/rt\/socket\.io\?EIO=4&transport=polling&t=/);
  });
});
