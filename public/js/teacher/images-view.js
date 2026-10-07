// 내 그림: the teacher's uploaded pictures. Upload new ones, and delete (Storage file and
// row) unless an open class still uses the picture.
import { h, icon, setTitle } from './dom.js';
import { pictureCard, uploadedDetail } from './picture-cards.js';
import { loadMyImages } from './pictures.js';
import { deleteImage } from './upload.js';
import { uploadPanel } from './upload-panel.js';
import { uploadErrorMessage } from './upload-rules.js';

export function renderImages(main, ctx) {
  ctx.setBar('nav', { active: 'images' });
  setTitle('내 그림');
  const body = h('div', { class: 'card t-card', 'aria-live': 'polite' });
  const uploader = h(
    'section',
    { class: 'card t-card t-images-upload', 'aria-labelledby': 't-images-upload-title' },
    h('h2', { class: 't-step', id: 't-images-upload-title' }, '사진 올리기'),
    uploadPanel({ client: ctx.client, onUploaded: () => load() }),
  );
  main.append(
    h(
      'div',
      { class: 't-wrap' },
      h(
        'div',
        { class: 't-head' },
        h(
          'div',
          {},
          h('h1', { tabindex: '-1' }, '내 그림'),
          h('p', { class: 'sub' }, '나만 볼 수 있어요 · 지울 때까지 보관 · 1년 동안 쓰지 않으면 정리돼요'),
        ),
      ),
      uploader,
      body,
    ),
  );

  let alive = true;

  function imageCard(image) {
    const message = h('p', { class: 't-pic-msg', role: 'alert' });
    const actions = h('div', { class: 't-pic-actions' });
    const card = h(
      'div',
      { class: 't-pic-manage', 'data-image-id': image.id },
      pictureCard({ src: image.url, title: '내 그림', detail: uploadedDetail(image) }),
      actions,
      message,
    );

    function idle() {
      actions.replaceChildren(
        h(
          'button',
          { class: 'btn t-pic-delete', type: 'button', 'aria-label': `${uploadedDetail(image)}에 올린 그림 지우기`, onclick: confirm },
          '지우기',
        ),
      );
    }
    function confirm() {
      message.textContent = '';
      const yes = h('button', { class: 'btn danger', type: 'button', onclick: remove }, '지우기');
      const no = h('button', { class: 'btn', type: 'button', onclick: () => (idle(), actions.querySelector('button')?.focus()) }, '그대로 두기');
      actions.replaceChildren(h('span', { class: 't-confirm-text' }, '지울까요? 파일도 함께 지워져요.'), yes, no);
      yes.focus();
    }
    async function remove() {
      actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await deleteImage(ctx.client, image);
        if (alive) load('지웠어요.');
      } catch (error) {
        console.error(error);
        if (!alive) return;
        idle();
        message.textContent = uploadErrorMessage(error);
      }
    }
    idle();
    return card;
  }

  async function load(note = '') {
    body.setAttribute('aria-busy', 'true');
    if (!body.firstChild) body.replaceChildren(h('p', { class: 't-loading' }, '내 그림을 불러오는 중이에요…'));
    try {
      const images = await loadMyImages(ctx.client);
      if (!alive) return;
      body.replaceChildren(
        ...(note ? [h('p', { class: 't-done', role: 'status' }, note)] : []),
        images.length
          ? h('div', { class: 't-pics' }, images.map(imageCard))
          : h(
              'div',
              { class: 't-empty t-empty-inline' },
              h('h2', {}, '아직 올린 그림이 없어요'),
              h('p', { class: 'sub' }, '우리 반 사진이나 그림을 위에서 올리면 여기에 모여요.'),
            ),
      );
    } catch (error) {
      console.error(error);
      if (!alive) return;
      body.replaceChildren(
        h(
          'div',
          { class: 't-empty t-empty-inline', role: 'alert' },
          h('h2', {}, '내 그림을 불러오지 못했어요'),
          h('p', { class: 'sub' }, '인터넷 연결을 확인하고 다시 시도해 주세요.'),
          h('button', { class: 'btn', type: 'button', onclick: () => load() }, icon('refresh'), '다시 시도'),
        ),
      );
    } finally {
      body.removeAttribute('aria-busy');
    }
  }
  load();
  return () => {
    alive = false;
  };
}
