// Six-cell class code field (mockup student-phone #1). One real <input> lies over six drawn
// cells, so typing, pasting, autofill, the number keypad and screen readers all work on a
// normal text field; the cells only mirror its value.
import { normalizeCode } from './routes.js';

const CODE_LENGTH = 6;

// Builds the same markup as index.html (home) for screens drawn by script.
export function createCodeField({ id = 'code', value = '' } = {}) {
  const field = document.createElement('div');
  field.className = 'code-field';
  field.innerHTML =
    `<label class="sr-only" for="${id}">수업 코드 6자리</label>` +
    `<input class="code-input" id="${id}" name="code" type="text" inputmode="numeric" autocomplete="off"` +
    ` enterkeyhint="go" pattern="[0-9]{6}" maxlength="12" title="숫자 6자리" required>` +
    '<div class="code-cells" aria-hidden="true"><span></span><span></span><span></span><i></i><span></span><span></span><span></span></div>';
  field.querySelector('input').value = normalizeCode(value);
  return field;
}

export function enhanceCodeField(field) {
  const input = field.querySelector('.code-input');
  const cells = [...field.querySelectorAll('.code-cells span')];
  field.classList.add('is-enhanced');

  const toEnd = () => {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  function draw() {
    const digits = normalizeCode(input.value);
    if (digits !== input.value) input.value = digits;
    const focused = document.activeElement === input;
    cells.forEach((cell, i) => {
      cell.textContent = digits[i] ?? '';
      cell.classList.toggle('is-filled', i < digits.length);
      cell.classList.toggle('is-cur', focused && i === Math.min(digits.length, CODE_LENGTH - 1));
    });
  }

  input.addEventListener('input', () => {
    field.classList.remove('is-error');
    input.removeAttribute('aria-invalid');
    draw();
  });
  input.addEventListener('focus', () => {
    draw();
    // The cells read left to right, so keep the caret at the end.
    requestAnimationFrame(toEnd);
  });
  input.addEventListener('click', toEnd);
  input.addEventListener('blur', draw);
  draw();
  return {
    input,
    showError() {
      field.classList.remove('is-error');
      void field.offsetWidth; // restart the shake
      field.classList.add('is-error');
    },
  };
}
