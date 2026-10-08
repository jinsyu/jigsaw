// Picture thumbnails shared by 새 수업 (selectable) and 내 그림 (view only).
import { h, icon } from './dom.js';
import { formatDateTime } from './format.js';

// With `radio` ({ name, value, checked, onchange }) the card is a radio button in a group,
// so arrow keys move between pictures and screen readers announce the choice.
// `level` (쉬움 | 보통 | 어려움, built-in pictures) shows on the picture's corner.
export function pictureCard({ src, title, detail, radio, level }) {
  const img = src
    ? h('img', { src, alt: '', width: 360, height: 240, loading: 'lazy', decoding: 'async' })
    : h('span', { class: 't-thumb-none' }, icon('image', 28));
  const caption = h('span', { class: 't-pic-cap' }, h('b', {}, title), detail ? h('small', {}, detail) : null);
  const badge = level ? h('span', { class: 't-level', 'data-level': level }, level) : null;
  if (!radio) return h('div', { class: 't-pic' }, h('span', { class: 't-pic-img' }, img, badge), caption);
  const input = h('input', {
    class: 'sr-only',
    type: 'radio',
    name: radio.name,
    value: radio.value,
    checked: radio.checked,
    onchange: radio.onchange,
  });
  return h(
    'label',
    { class: 't-pic is-choice' },
    input,
    h('span', { class: 't-pic-img' }, img, badge),
    caption,
    h('span', { class: 't-check' }, icon('check', 16)),
  );
}

export function uploadedDetail(image) {
  return formatDateTime(image.createdAt).replace(/ (오전|오후).*$/, '');
}

export function faceWarning() {
  return h('p', { class: 't-warnline' }, icon('warn', 18), '학생 얼굴이 나온 사진은 학교 방침을 확인한 뒤 올려 주세요.');
}
