// T20: the server's own check of teachers' WebP files (pure).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBuiltins } from '../../server/src/builtin.js';
import { MAX_BYTES, imageRefusal, webpSize } from '../../server/src/teacher/images.js';

const BUILTIN = new URL('../../public/images/builtin/', import.meta.url);

function vp8x(width, height) {
  const b = new Uint8Array(30);
  b.set(new TextEncoder().encode('RIFF'), 0);
  b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  const put24 = (at, v) => {
    b[at] = v & 0xff;
    b[at + 1] = (v >> 8) & 0xff;
    b[at + 2] = (v >> 16) & 0xff;
  };
  put24(24, width - 1);
  put24(27, height - 1);
  return b;
}

describe('webpSize', () => {
  it('내장 그림 파일들의 가로·세로를 index.json 과 같게 읽는다', () => {
    const builtins = loadBuiltins();
    expect(builtins.size).toBeGreaterThan(10);
    for (const [key, size] of builtins) {
      const bytes = readFileSync(new URL(`${key}.webp`, BUILTIN));
      expect(webpSize(bytes), key).toEqual(size);
    }
  });

  it('VP8X 머리말을 읽는다', () => {
    expect(webpSize(vp8x(1600, 900))).toEqual({ width: 1600, height: 900 });
  });

  it('WebP 가 아니면 null', () => {
    expect(webpSize(new TextEncoder().encode('GIF89a this is not a webp file at all'))).toBeNull();
    expect(webpSize(new Uint8Array(10))).toBeNull();
  });
});

describe('imageRefusal (D2)', () => {
  it('형식·크기·긴 변을 검사한다', () => {
    expect(imageRefusal(new Uint8Array(0))).toBe('empty');
    expect(imageRefusal(new TextEncoder().encode('x'.repeat(100)))).toBe('not_webp');
    expect(imageRefusal(vp8x(2000, 1500))).toBeNull();
    expect(imageRefusal(vp8x(2001, 100))).toBe('too_big_picture');
    const big = new Uint8Array(MAX_BYTES + 1);
    big.set(vp8x(100, 100));
    expect(imageRefusal(big)).toBe('too_large');
  });
});
