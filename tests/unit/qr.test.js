import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { joinUrl, qrMatrix, qrSvg } from '../../public/js/teacher/qr.js';

// Paints the matrix (with a 4-module quiet zone) into RGBA pixels and reads it back.
function decode(matrix, scale = 6) {
  const quiet = 4;
  const side = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const r = Math.floor(y / scale) - quiet;
      const c = Math.floor(x / scale) - quiet;
      if (r >= 0 && c >= 0 && r < matrix.size && c < matrix.size && matrix.isDark(r, c)) {
        const i = (y * side + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return jsQR(data, side, side)?.data;
}

describe('joinUrl', () => {
  it('fills the code into the join address', () => {
    expect(joinUrl('https://jigsaw.gyosil.app', '482913')).toBe('https://jigsaw.gyosil.app/join?code=482913');
  });
});

describe('qrMatrix', () => {
  it.each(['https://jigsaw.gyosil.app/join?code=482913', 'http://localhost:4173/join?code=000123'])(
    'encodes %s so a camera reads it back',
    (url) => {
      expect(decode(qrMatrix(url))).toBe(url);
    },
  );
});

describe('qrSvg', () => {
  it('draws one path with a white quiet zone and an accessible name', () => {
    const svg = qrSvg('https://jigsaw.gyosil.app/join?code=482913', '입장 QR 코드');
    expect(svg).toMatch(/^<svg [^>]*role="img"/);
    expect(svg).toContain('aria-label="입장 QR 코드"');
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain('shape-rendering="crispEdges"');
  });
});
