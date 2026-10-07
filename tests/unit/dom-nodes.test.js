import { describe, expect, it } from 'vitest';
import { nodes } from '../../public/js/teacher/dom.js';

describe('nodes', () => {
  it('drops null, undefined and false so the DOM never shows "null"', () => {
    const a = { id: 'a' };
    expect(nodes(a, null, undefined, false, 'text', [null, [a, false]])).toEqual([a, 'text', a]);
  });

  it('keeps 0 and empty strings', () => {
    expect(nodes(0, '')).toEqual([0, '']);
  });
});
