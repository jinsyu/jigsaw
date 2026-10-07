// 내 그림: the teacher's uploaded pictures (view only here; T8 adds uploading and deleting).
import { h, icon, setTitle } from './dom.js';
import { faceWarning, pictureCard, uploadBox, uploadedDetail } from './picture-cards.js';
import { loadMyImages } from './pictures.js';

export function renderImages(main, ctx) {
  ctx.setBar('nav', { active: 'images' });
  setTitle('내 그림');
  const body = h('div', { class: 'card t-card', 'aria-live': 'polite' });
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
          h('p', { class: 'sub' }, '나만 볼 수 있어요 · 지울 때까지 보관'),
        ),
      ),
      body,
    ),
  );

  let alive = true;
  async function load() {
    body.setAttribute('aria-busy', 'true');
    body.replaceChildren(h('p', { class: 't-loading' }, '내 그림을 불러오는 중이에요…'));
    try {
      const images = await loadMyImages(ctx.client);
      if (!alive) return;
      body.replaceChildren(
        images.length
          ? h(
              'div',
              { class: 't-pics' },
              images.map((image) => pictureCard({ src: image.url, title: '내 그림', detail: uploadedDetail(image) })),
              uploadBox(),
            )
          : h(
              'div',
              { class: 't-empty t-empty-inline' },
              h('h2', {}, '아직 올린 그림이 없어요'),
              h('p', { class: 'sub' }, '우리 반 사진이나 그림을 올리면 여기에 모여요. 사진 올리기는 곧 열려요.'),
            ),
        faceWarning(),
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
          h('button', { class: 'btn', type: 'button', onclick: load }, icon('refresh'), '다시 시도'),
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
