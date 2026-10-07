// QR code for the join address, drawn as one SVG path.
import qrcode from '../vendor/qrcode-generator-2.0.4.js';

const QUIET_ZONE = 4; // modules of white around the code, as the QR standard asks

export function joinUrl(origin, code) {
  return `${origin}/join?code=${code}`;
}

// Error correction M: still reads when a projector or a glare spoils part of it.
export function qrMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return { size, isDark: (row, col) => qr.isDark(row, col) };
}

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function qrSvg(text, label) {
  const { size, isDark } = qrMatrix(text);
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isDark(r, c)) d += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
    }
  }
  const side = size + QUIET_ZONE * 2;
  return (
    `<svg role="img" aria-label="${escapeAttr(label)}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${side}" height="${side}" fill="#fff"/><path fill="#1E2433" d="${d}"/></svg>`
  );
}
