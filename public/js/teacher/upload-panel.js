// '사진 올리기' box used by 새 수업 and 내 그림: drop a photo, pick a file, or take one with
// the tablet camera. Shows the steps while it shrinks and uploads, and why it failed.
import { h, icon } from './dom.js';
import { faceWarning } from './picture-cards.js';
import { uploadImage } from './upload.js';
import { uploadErrorMessage } from './upload-rules.js';

const STAGES = {
  open: [0.1, '사진을 여는 중이에요…'],
  shrink: [0.25, '크기를 줄이는 중이에요…'],
  encoder: [0.35, '변환 도구를 불러오는 중이에요… (처음 한 번만)'],
  encode: [0.5, '사진 정보를 지우고 바꾸는 중이에요…'],
  upload: [0.7, '올리는 중이에요…'],
};

const coarsePointer = () => window.matchMedia?.('(any-pointer: coarse)').matches ?? false;

let panelCount = 0;

/**
 * @param {{ api: object, onUploaded: (image: object) => void }} options  api: the teacher app's rt requests
 */
export function uploadPanel({ api, onUploaded }) {
  const id = `t-upload-${++panelCount}`;
  // The buttons below open these; screen readers only need the buttons.
  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', id: `${id}-file`, tabindex: '-1', 'aria-hidden': 'true' });
  const cameraInput = h('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    class: 'sr-only',
    id: `${id}-camera`,
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  const pickButton = h('button', { class: 'btn pri t-upload-pick', type: 'button', onclick: () => fileInput.click() }, icon('upload', 20), '사진 고르기');
  const cameraButton = coarsePointer()
    ? h('button', { class: 'btn t-upload-camera', type: 'button', onclick: () => cameraInput.click() }, icon('image', 20), '카메라로 찍기')
    : null;
  const bar = h('progress', { class: 't-upload-bar', max: '1', value: '0', 'aria-label': '올리기 진행' });
  const statusText = h('span', {});
  const status = h('div', { class: 't-upload-status', role: 'status', hidden: true }, bar, statusText);
  const error = h('p', { class: 't-error', role: 'alert' });

  const drop = h(
    'div',
    { class: 't-drop', id },
    icon('upload', 30),
    h('b', {}, '사진을 여기로 끌어 놓거나 골라 주세요'),
    h('span', { class: 't-drop-note' }, 'JPG·PNG·WebP, 30MB까지 · 긴 변 2000px로 줄이고 촬영 위치 같은 정보는 지워요'),
    h('div', { class: 't-drop-actions' }, pickButton, cameraButton),
    fileInput,
    cameraInput,
  );

  let busy = false;
  function setBusy(on) {
    busy = on;
    pickButton.disabled = on;
    if (cameraButton) cameraButton.disabled = on;
    drop.classList.toggle('is-busy', on);
    drop.setAttribute('aria-busy', String(on));
  }

  function showStage(stage) {
    const [value, text] = STAGES[stage] ?? [0, ''];
    status.hidden = false;
    bar.value = value;
    statusText.textContent = text;
  }

  async function handle(file) {
    if (busy || !file) return;
    error.textContent = '';
    setBusy(true);
    try {
      const image = await uploadImage(api, file, showStage);
      bar.value = 1;
      statusText.textContent = '올렸어요. 바로 고를 수 있어요.';
      root.dataset.uploadedId = image.id; // the last picture uploaded here
      onUploaded?.(image);
    } catch (err) {
      console.error(err);
      status.hidden = true;
      error.textContent = uploadErrorMessage(err);
    } finally {
      setBusy(false);
      fileInput.value = '';
      cameraInput.value = '';
    }
  }

  for (const input of [fileInput, cameraInput]) input.addEventListener('change', () => handle(input.files?.[0]));

  // Drag and drop (desktop, also iPad with a second app).
  let depth = 0;
  drop.addEventListener('dragenter', (event) => {
    if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
    event.preventDefault();
    depth += 1;
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragover', (event) => {
    if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  });
  drop.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drop.classList.remove('is-over');
  });
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    drop.classList.remove('is-over');
    handle(event.dataTransfer?.files?.[0]);
  });

  const root = h('div', { class: 't-uploader' }, drop, status, error, faceWarning());
  return root;
}
