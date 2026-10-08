// Built-in picture lookup: pictures added after the server started come from the screens' copy.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createBuiltins, loadBuiltins } from '../../server/src/builtin.js';

const URL_ = 'https://screens.test/images/builtin/index.json';
const silent = { error: () => {} };
const reply = (images) => ({ ok: true, json: async () => ({ version: 1, images }) });

function setup({ remote = [{ key: 'new-cat', width: 1800, height: 1200 }], fetchImpl } = {}) {
  let t = 0;
  const fetch = fetchImpl ?? vi.fn(async () => reply(remote));
  const builtins = createBuiltins({
    local: new Map([['sea', { width: 1600, height: 900 }]]),
    indexUrl: URL_,
    fetchImpl: fetch,
    now: () => t,
    log: silent,
  });
  return { builtins, fetch, advance: (ms) => (t += ms) };
}

describe('createBuiltins', () => {
  it('아는 그림은 받아 오지 않고 바로 돌려준다', async () => {
    const { builtins, fetch } = setup();
    expect(await builtins.get('sea')).toEqual({ width: 1600, height: 900 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('모르는 그림이면 화면 쪽 목록을 받아 와 더한다', async () => {
    const { builtins, fetch } = setup();
    expect(await builtins.get('new-cat')).toEqual({ width: 1800, height: 1200 });
    expect(fetch).toHaveBeenCalledWith(URL_, expect.objectContaining({ cache: 'no-store' }));
    expect(await builtins.get('new-cat')).toEqual({ width: 1800, height: 1200 });
    expect(await builtins.get('sea')).toEqual({ width: 1600, height: 900 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('없는 그림이 계속 와도 1분에 한 번만 받아 온다', async () => {
    const { builtins, fetch, advance } = setup();
    expect(await builtins.get('nope')).toBeUndefined();
    expect(await builtins.get('nope-2')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(60_000);
    expect(await builtins.get('nope')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('동시에 온 요청은 한 번 받아 온 결과를 같이 쓴다', async () => {
    const { builtins, fetch } = setup();
    const sizes = await Promise.all([builtins.get('new-cat'), builtins.get('new-cat'), builtins.get('other')]);
    expect(sizes).toEqual([{ width: 1800, height: 1200 }, { width: 1800, height: 1200 }, undefined]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('형식이 틀린 키는 받아 오지 않는다', async () => {
    const { builtins, fetch } = setup();
    for (const key of ['Bad Key', '../x', '', 'a'.repeat(81), null]) expect(await builtins.get(key)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('받아 오기가 실패하거나 내용이 이상해도 아는 그림은 그대로다', async () => {
    const error = vi.fn();
    const failing = createBuiltins({
      local: new Map([['sea', { width: 1600, height: 900 }]]),
      indexUrl: URL_,
      fetchImpl: async () => ({ ok: false, status: 503 }),
      log: { error },
    });
    expect(await failing.get('new-cat')).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    expect(await failing.get('sea')).toEqual({ width: 1600, height: 900 });

    const { builtins } = setup({
      remote: [
        { key: 'zero', width: 0, height: 10 },
        { key: 'Bad Key', width: 10, height: 10 },
        { key: 'sea', width: 'x', height: 1 },
      ],
    });
    expect(await builtins.get('zero')).toBeUndefined();
    expect(await builtins.get('sea')).toEqual({ width: 1600, height: 900 });
  });

  it('지금 index.json 의 모든 그림 키를 받아들인다', () => {
    const { images } = JSON.parse(readFileSync(new URL('../../public/images/builtin/index.json', import.meta.url), 'utf8'));
    expect(loadBuiltins().size).toBe(images.length);
  });
});
