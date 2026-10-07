// Teachers' own pictures (T8, spec D2): shrink in the browser, store as WebP in the
// private "images" bucket, and delete again (file and row).
//
// - Redrawing on a canvas keeps only the pixels: EXIF (camera, place, time) is dropped.
//   <img> applies the EXIF orientation before drawing, so photos stay upright.
// - Browsers that cannot encode WebP from a canvas (Safari returns PNG) load a pinned
//   WASM encoder from the CDN, only then (CSP: 'wasm-unsafe-eval', cdn.jsdelivr.net).
import {
  MAX_UPLOAD_BYTES,
  MESSAGES,
  MIN_LONG_SIDE,
  WEBP_QUALITIES,
  checkFile,
  fitSize,
  isHeic,
  newImageId,
} from './upload-rules.js';

const BUCKET = 'images';
const SIGNED_URL_SECONDS = 60 * 60;
const JSQUASH_VERSION = '1.5.0';
const JSQUASH_BASE = `https://cdn.jsdelivr.net/npm/@jsquash/webp@${JSQUASH_VERSION}`;
const JSQUASH_ENCODE = `${JSQUASH_BASE}/encode.js/+esm`;

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
  wasmEncoder ??= import(JSQUASH_ENCODE)
    .then(async (mod) => {
      // The CDN bundle cannot find its .wasm next to itself: point it there.
      await mod.init({ locateFile: (path) => `${JSQUASH_BASE}/codec/enc/${path}` });
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
 * Uploads a picture: Storage file first, then the images row (the file is removed again
 * if the row cannot be saved). Resolves with the row plus a short-lived URL.
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {File} file
 * @param {(stage: string) => void} [onStage]  prepareImage stages, then 'upload' | 'save'
 */
export async function uploadImage(client, file, onStage = () => {}) {
  const { blob, width, height, encoder } = await prepareImage(file, onStage);
  const { data: auth, error: authError } = await client.auth.getSession();
  if (authError || !auth.session) throw userError(MESSAGES.failed, authError);
  const id = newImageId();
  const path = `${auth.session.user.id}/${id}.webp`;

  onStage('upload');
  const { error: uploadError } = await client.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'image/webp', upsert: false, cacheControl: '3600' });
  if (uploadError) throw userError(uploadErrorText(uploadError), uploadError);

  onStage('save');
  const { data: row, error: rowError } = await client
    .from('images')
    .insert({ id, width, height })
    .select('id, path, width, height, created_at')
    .single();
  if (rowError) {
    await client.storage.from(BUCKET).remove([path]);
    throw userError(uploadErrorText(rowError), rowError);
  }
  const { data: signed } = await client.storage.from(BUCKET).createSignedUrl(row.path, SIGNED_URL_SECONDS);
  return { ...row, url: signed?.signedUrl ?? null, encoder };
}

function uploadErrorText(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? ''}`;
  return /fetch|network|load failed/i.test(text) ? MESSAGES.network : MESSAGES.failed;
}

export const IN_USE_MESSAGE = '열려 있는 수업에서 쓰고 있어 지울 수 없어요. 수업을 끝낸 뒤 지워 주세요.';

/**
 * Deletes a picture: refuses while an open session uses it, then removes the Storage file
 * and the row (file first, so a failure leaves the card to try again).
 */
export async function deleteImage(client, image) {
  const { data: open, error: openError } = await client
    .from('sessions')
    .select('id')
    .eq('image_id', image.id)
    .neq('status', 'ended')
    .limit(1);
  if (openError) throw userError(uploadErrorText(openError), openError);
  if (open.length) throw userError(IN_USE_MESSAGE);
  const { error: fileError } = await client.storage.from(BUCKET).remove([image.path]);
  if (fileError) throw userError(uploadErrorText(fileError), fileError);
  const { error: rowError } = await client.from('images').delete().eq('id', image.id);
  if (rowError) throw userError(uploadErrorText(rowError), rowError);
}
