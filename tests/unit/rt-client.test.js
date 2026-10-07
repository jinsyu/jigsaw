import { describe, expect, it } from 'vitest';
import { RtError, rtRequest } from '../../public/js/rt-client.js';

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
