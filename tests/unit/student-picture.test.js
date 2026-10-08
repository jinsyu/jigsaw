import { describe, expect, it } from 'vitest';
import { loadPictureInfo } from '../../public/js/student/puzzle.js';

const index = { images: [{ key: 'great-wave', src: '/images/builtin/great-wave.webp', width: 1800, height: 1232, credit: '가나가와' }] };
const fetchIndex = async () => ({ ok: true, json: async () => index });

describe('student class picture (built-in)', () => {
  it('reads a built-in picture with its credit line', async () => {
    expect(await loadPictureInfo({ builtinKey: 'great-wave' }, fetchIndex)).toMatchObject({ src: '/images/builtin/great-wave.webp', width: 1800, height: 1232, credit: '가나가와' });
  });

  it('says so when the class picture is no longer built in (picture_gone)', async () => {
    await expect(loadPictureInfo({ builtinKey: 'sea' }, fetchIndex)).rejects.toMatchObject({ code: 'picture_gone' });
  });
});
