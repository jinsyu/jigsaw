import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { h, setStyle } from '../../public/js/teacher/dom.js';

// A tiny stand-in for DOM elements: records attributes and CSSOM style calls.
function fakeElement(tag) {
  const props = new Map();
  return {
    tag,
    attributes: {},
    children: [],
    style: { setProperty: (name, value) => props.set(name, value), props },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener() {},
    append(...items) {
      this.children.push(...items);
    },
  };
}

let saved;
beforeEach(() => {
  saved = globalThis.document;
  globalThis.document = { createElement: fakeElement };
});
afterEach(() => {
  globalThis.document = saved;
});

describe('h() style (CSP: no style attributes)', () => {
  it('sets custom properties and normal declarations through element.style', () => {
    const node = h('div', { class: 't-groups', style: '--group-cols: 3; gap: 8px' });
    expect(node.attributes.style).toBeUndefined();
    expect(Object.fromEntries(node.style.props)).toEqual({ '--group-cols': '3', gap: '8px' });
  });

  it('takes an object too, and skips a null style', () => {
    const node = h('li', { style: { '--me': '#F0544F' } });
    expect(node.style.props.get('--me')).toBe('#F0544F');
    const none = h('li', { style: null });
    expect(none.style.props.size).toBe(0);
    expect(none.attributes.style).toBeUndefined();
  });

  it('keeps values with colons whole and rejects broken declarations', () => {
    const node = fakeElement('i');
    setStyle(node, 'background-image: url(https://example.test/a.png)');
    expect(node.style.props.get('background-image')).toBe('url(https://example.test/a.png)');
    expect(() => setStyle(fakeElement('i'), 'nonsense')).toThrow();
  });
});
