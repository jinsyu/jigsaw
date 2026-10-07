import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_LONG_SIDE,
  MESSAGES,
  checkFile,
  fitSize,
  isHeic,
  looksLikeWebp,
  newImageId,
  uploadErrorMessage,
} from '../../public/js/teacher/upload-rules.js';

const file = (type, size = 1000, name = 'photo') => ({ type, size, name });

describe('checkFile', () => {
  it('lets pictures through', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) expect(checkFile(file(type))).toBeNull();
  });

  it('turns away other files, empty files and huge files', () => {
    expect(checkFile(file('application/pdf'))).toBe(MESSAGES.notImage);
    expect(checkFile(file(''))).toBe(MESSAGES.notImage);
    expect(checkFile(null)).toBe(MESSAGES.notImage);
    expect(checkFile(file('image/jpeg', 0))).toBe(MESSAGES.empty);
    expect(checkFile(file('image/jpeg', MAX_FILE_BYTES + 1))).toBe(MESSAGES.tooLarge);
  });

  it('lets HEIC through to try (Safari opens them) and recognises it', () => {
    expect(checkFile(file('image/heic'))).toBeNull();
    expect(checkFile(file('', 1000, 'IMG_1234.HEIC'))).toBeNull();
    expect(isHeic(file('', 1000, 'IMG_1234.heif'))).toBe(true);
    expect(isHeic(file('image/jpeg'))).toBe(false);
  });

  it('checks empty and huge files before the HEIC exception', () => {
    expect(checkFile(file('image/heic', 0))).toBe(MESSAGES.empty);
    expect(checkFile(file('', 0, 'IMG_1234.HEIC'))).toBe(MESSAGES.empty);
    expect(checkFile(file('image/heic', MAX_FILE_BYTES + 1))).toBe(MESSAGES.tooLarge);
    expect(checkFile(file('', MAX_FILE_BYTES + 1, 'IMG_1234.heif'))).toBe(MESSAGES.tooLarge);
  });
});

describe('fitSize', () => {
  it('keeps the long side at most 2000 px and the proportions', () => {
    expect(fitSize(4032, 3024)).toEqual({ width: MAX_LONG_SIDE, height: 1500 });
    expect(fitSize(3000, 4500)).toEqual({ width: 1333, height: MAX_LONG_SIDE });
    expect(fitSize(1200, 800)).toEqual({ width: 1200, height: 800 }); // never enlarged
  });

  it('refuses sizes that make no sense', () => {
    expect(() => fitSize(0, 10)).toThrow();
    expect(() => fitSize(NaN, 10)).toThrow();
  });
});

describe('helpers', () => {
  it('recognises WebP bytes', () => {
    expect(looksLikeWebp(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(looksLikeWebp(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
  });

  it('explains network failures differently from other failures', () => {
    expect(uploadErrorMessage(new TypeError('Failed to fetch'))).toBe(MESSAGES.network);
    expect(uploadErrorMessage({ message: 'new row violates row-level security policy' })).toBe(MESSAGES.failed);
    expect(uploadErrorMessage({ userMessage: '직접 정한 안내' })).toBe('직접 정한 안내');
  });

  it('makes v4 UUIDs without crypto.randomUUID (plain http on a LAN address)', () => {
    const id = newImageId({ getRandomValues: (a) => a.map((_, i) => (i * 37) & 255) });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
