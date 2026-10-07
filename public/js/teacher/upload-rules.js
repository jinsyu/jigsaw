// Rules for teachers' own pictures (T8, spec D2): checked in the browser before anything
// is uploaded. Pure functions so they can be unit tested.

// Long side of the stored picture (images_long_side check in the schema).
export const MAX_LONG_SIDE = 2000;
// Smaller pictures make blurry puzzles.
export const MIN_LONG_SIDE = 200;
// What a teacher may pick (phone photos are a few MB; scans can be large).
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
// What the Storage bucket accepts (file_size_limit of the "images" bucket).
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const WEBP_QUALITIES = [0.85, 0.75, 0.65, 0.55];

const IMAGE_TYPE = /^image\//;
const HEIC = /^image\/hei[cf]$|\.hei[cf]$/i;

export const MESSAGES = {
  notImage: '사진 파일(JPG, PNG, WebP 등)만 올릴 수 있어요.',
  heic: 'HEIC 사진은 이 브라우저에서 열 수 없어요. JPG로 바꾸거나 사진 앱에서 공유해 올려 주세요.',
  tooLarge: '사진이 너무 커요. 30MB보다 작은 사진을 골라 주세요.',
  empty: '빈 파일이에요. 다른 사진을 골라 주세요.',
  tooSmall: '사진이 너무 작아요. 긴 변이 200px보다 큰 사진을 골라 주세요.',
  cannotOpen: '이 사진을 열지 못했어요. 다른 사진을 골라 주세요.',
  cannotEncode: '사진을 바꾸지 못했어요. 다른 사진을 골라 주세요.',
  network: '올리지 못했어요. 인터넷 연결을 확인하고 다시 올려 주세요.',
  failed: '올리지 못했어요. 잠시 뒤 다시 올려 주세요.',
};

// null when the file may be tried, otherwise the message to show.
export function checkFile(file) {
  if (!file) return MESSAGES.notImage;
  // HEIC may have no type in some browsers but is still tried (Safari opens it).
  if (!IMAGE_TYPE.test(file.type) && !isHeic(file)) return MESSAGES.notImage;
  if (file.size === 0) return MESSAGES.empty;
  if (file.size > MAX_FILE_BYTES) return MESSAGES.tooLarge;
  return null;
}

export function isHeic(file) {
  return HEIC.test(file?.type ?? '') || HEIC.test(file?.name ?? '');
}

// Size to draw the picture at: the long side at most MAX_LONG_SIDE, proportions kept.
export function fitSize(width, height, maxLongSide = MAX_LONG_SIDE) {
  if (!(width > 0 && height > 0)) throw new RangeError(`bad size: ${width} x ${height}`);
  const k = Math.min(1, maxLongSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

// The first bytes of a WebP file: "RIFF" .... "WEBP".
export function looksLikeWebp(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const text = (from, to) => String.fromCharCode(...b.slice(from, to));
  return b.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP';
}

// Message for a failed upload (supabase-js errors, fetch failures).
export function uploadErrorMessage(error) {
  if (!error) return MESSAGES.failed;
  if (error.userMessage) return error.userMessage;
  const text = `${error.name ?? ''} ${error.message ?? ''}`;
  if (/Failed to fetch|NetworkError|Load failed|network|ERR_/i.test(text) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return MESSAGES.network;
  }
  return MESSAGES.failed;
}

// UUID v4 also on plain http LAN addresses (crypto.randomUUID needs a secure context).
export function newImageId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const b = cryptoApi.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
