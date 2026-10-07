// Small modal dialogs shared by the lobby and 모둠 한눈에 보기.
import { h } from './dom.js';

// Yes/no question. Resolves true when confirmed.
export function confirmDialog(main, { title, text, confirm, tone = 'pri' }) {
  return new Promise((resolve) => {
    const yes = h('button', { class: `btn ${tone}`, type: 'button' }, confirm);
    const no = h('button', { class: 'btn', type: 'button', autofocus: true }, '취소');
    const dialog = h(
      'dialog',
      { class: 't-dialog', 'aria-labelledby': 't-confirm-title' },
      h('h2', { id: 't-confirm-title' }, title),
      h('p', { class: 'sub' }, text),
      h('div', { class: 't-actions' }, no, yes),
    );
    let answer = false;
    yes.addEventListener('click', () => {
      answer = true;
      dialog.close();
    });
    no.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    main.append(dialog);
    dialog.showModal();
  });
}

// A question whose answer runs an action that can fail (ending a class): the dialog stays
// open with the error, and closes once `action` resolves. Returns the dialog (not yet open).
export function actionDialog({ id, title, text, confirm, busy, tone = 'danger', failed, action }) {
  const error = h('p', { class: 't-error', role: 'alert' });
  const yes = h('button', { class: `btn ${tone}`, type: 'button' }, confirm);
  const no = h('button', { class: 'btn', type: 'button', autofocus: true }, '취소');
  const dialog = h(
    'dialog',
    { class: 't-dialog', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-text` },
    h('h2', { id: `${id}-title` }, title),
    h('p', { class: 'sub', id: `${id}-text` }, text),
    error,
    h('div', { class: 't-actions' }, no, yes),
  );
  no.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    error.textContent = '';
  });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    yes.textContent = busy;
    try {
      await action();
      if (dialog.open) dialog.close();
    } catch (err) {
      console.error(err);
      error.textContent = failed;
    } finally {
      yes.disabled = false;
      yes.textContent = confirm;
    }
  });
  return dialog;
}
