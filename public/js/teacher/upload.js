// Teachers' own pictures (T8, spec D2): shrink in the browser, send the WebP to the rt server
// (which stores it in the private bucket jigsaw-images), and delete again (file and row).
//
// - Redrawing on a canvas keeps only the pixels: EXIF (camera, place, time) is dropped.
//   <img> applies the EXIF orientation before drawing, so photos stay upright.
// - Browsers that cannot encode WebP from a canvas (Safari returns PNG) load the WASM
//   encoder kept in js/vendor, only then (CSP: 'wasm-unsafe-eval').
import {
  MAX_UPLOAD_BYTES,
  MESSAGES,
  MIN_LONG_SIDE,
  WEBP_QUALITIES,
  checkFile,
  fitSize,
  isHeic,
} from './upload-rules.js';

// Relative to this module, so it works on any host. The .wasm sits next to its loader.
const WASM_ENCODER = new URL('../vendor/jsquash-webp-1.5.0/encode.js', import.meta.url).href;

// Error with the message to show the teacher.
function userError(message, cause) {
  const error = new Error(message, { cause });
  error.userMessage = message;
  return error;
}

async function decode(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch (cause) {
    throw userError(isHeic(file) ? MESSAGES.heic : MESSAGES.cannotOpen, cause);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const canvasBlob = (canvas, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));

let wasmEncoder = null;
async function loadWasmEncoder() {
  wasmEncoder ??= import(WASM_ENCODER)
    .then(async (mod) => {
      await mod.init();
      return mod.default;
    })
    .catch((error) => {
      wasmEncoder = null;
      throw error;
    });
  return wasmEncoder;
}

/**
 * Shrinks the picture (long side ≤ 2000 px) and encodes it as WebP without metadata.
 * @param {File} file
 * @param {(stage: string) => void} [onStage]  'open' | 'shrink' | 'encoder' | 'encode'
 * @returns {Promise<{ blob: Blob, width: number, height: number, encoder: 'canvas' | 'wasm' }>}
 */
export async function prepareImage(file, onStage = () => {}) {
  const problem = checkFile(file);
  if (problem) throw userError(problem);
  onStage('open');
  const img = await decode(file);
  if (Math.max(img.naturalWidth, img.naturalHeight) < MIN_LONG_SIDE) throw userError(MESSAGES.tooSmall);
  onStage('shrink');
  const { width, height } = fitSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  onStage('encode');
  let encoder = 'canvas';
  let encodeWasm = null;
  for (const quality of WEBP_QUALITIES) {
    let blob = encodeWasm ? null : await canvasBlob(canvas, quality);
    if (!blob || blob.type !== 'image/webp') {
      if (!encodeWasm) {
        onStage('encoder');
        try {
          encodeWasm = await loadWasmEncoder();
        } catch (cause) {
          throw userError(MESSAGES.network, cause);
        }
        onStage('encode');
      }
      encoder = 'wasm';
      const pixels = ctx.getImageData(0, 0, width, height);
      try {
        blob = new Blob([await encodeWasm(pixels, { quality: Math.round(quality * 100) })], { type: 'image/webp' });
      } catch (cause) {
        throw userError(MESSAGES.cannotEncode, cause);
      }
    }
    if (blob.size <= MAX_UPLOAD_BYTES) return { blob, width, height, encoder };
  }
  throw userError(MESSAGES.cannotEncode);
}

/**
 * Uploads a picture through the rt server, which checks it again and stores it in the private
 * bucket (spec D2). Resolves with { id, width, height, url, encoder }.
 * @param {{ upload: (path: string, blob: Blob) => Promise<object> }} api
 * @param {File} file
 * @param {(stage: string) => void} [onStage]  prepareImage stages, then 'upload'
 */
export async function uploadImage(api, file, onStage = () => {}) {
  const { blob, encoder } = await prepareImage(file, onStage);
  onStage('upload');
  try {
    const { image } = await api.upload('/api/images', blob);
    return { ...image, encoder };
  } catch (error) {
    throw userError(UPLOAD_REFUSALS[error?.code] ?? requestErrorText(error), error);
  }
}

const UPLOAD_REFUSALS = {
  too_many_images: '내 그림은 100장까지 둘 수 있어요. 안 쓰는 그림을 지운 뒤 올려 주세요.',
  too_many_uploads: '사진을 너무 자주 올렸어요. 잠시 뒤 다시 올려 주세요.',
};

function requestErrorText(error) {
  return error?.network ? MESSAGES.network : MESSAGES.failed;
}

export const IN_USE_MESSAGE = '열려 있는 수업에서 쓰고 있어 지울 수 없어요. 수업을 끝낸 뒤 지워 주세요.';
export const GONE_MESSAGE = '이미 지워진 그림이에요. 목록을 새로 불러와 주세요.';

/**
 * Deletes a picture (Storage file and row). The rt server refuses while an open class uses it.
 */
export async function deleteImage(api, image) {
  try {
    await api.del(`/api/images/${encodeURIComponent(image.id)}`);
  } catch (error) {
    if (error?.code === 'image_in_use') throw userError(IN_USE_MESSAGE, error);
    if (error?.code === 'not_found') throw userError(GONE_MESSAGE, error);
    throw userError(requestErrorText(error), error);
  }
}
