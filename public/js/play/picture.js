// Loads the puzzle picture into a canvas no larger than MAX_PICTURE_EDGE on the
// long side (spec risk: low-end tablets). Vector pictures are rasterised at that size.

export const MAX_PICTURE_EDGE = 2048;

export function rasterSize(naturalW, naturalH, isVector) {
  const long = Math.max(naturalW, naturalH);
  const target = isVector ? MAX_PICTURE_EDGE : Math.min(MAX_PICTURE_EDGE, long);
  const k = target / long;
  return { width: Math.max(1, Math.round(naturalW * k)), height: Math.max(1, Math.round(naturalH * k)) };
}

export async function loadPicture(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  try {
    await img.decode();
  } catch (cause) {
    throw new Error(`picture failed to load: ${src}`, { cause });
  }
  const isVector = /\.svg(?:[?#]|$)/i.test(src);
  const { width, height } = rasterSize(img.naturalWidth, img.naturalHeight, isVector);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas;
}
