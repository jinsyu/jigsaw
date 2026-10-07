// Teachers' own pictures: private bucket jigsaw-images/<teacher>/<image>.webp and jigsaw.images.
// The browser already shrank the picture to WebP; the server checks it again (spec D2):
// WebP signature, at most MAX_BYTES, long side at most MAX_LONG_SIDE (read from the header).
import { randomUUID } from 'node:crypto';

export const BUCKET = 'jigsaw-images';
export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_LONG_SIDE = 2000;
const SIGNED_URL_SECONDS = 60 * 60;
// A cached signed URL is reused while it has at least this long left.
const REUSE_MARGIN_MS = 10 * 60 * 1000;

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const u24 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

// { width, height } of a WebP file (VP8, VP8L or VP8X), or null when it is not one.
export function webpSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8X') return { width: u24(b, 24) + 1, height: u24(b, 27) + 1 };
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

// Why the bytes cannot be stored, or null.
export function imageRefusal(bytes) {
  if (bytes.length === 0) return 'empty';
  if (bytes.length > MAX_BYTES) return 'too_large';
  const size = webpSize(bytes);
  if (!size || size.width < 1 || size.height < 1) return 'not_webp';
  if (Math.max(size.width, size.height) > MAX_LONG_SIDE) return 'too_big_picture';
  return null;
}

export const imagePath = (teacherId, imageId) => `${teacherId}/${imageId}.webp`;

export function createImages({ db, isOpenUse, maxPerTeacher = 100, now = Date.now }) {
  const signed = new Map(); // path -> { url, expiresAt }

  async function signedUrls(paths) {
    const t = now();
    const missing = paths.filter((p) => !(signed.get(p)?.expiresAt - t > REUSE_MARGIN_MS));
    if (missing.length > 0) {
      const { data, error } = await db.storage.from(BUCKET).createSignedUrls(missing, SIGNED_URL_SECONDS);
      if (error) throw error;
      for (const item of data) {
        if (item.error || !item.signedUrl) throw new Error(`signing failed for an image`);
        signed.set(item.path, { url: item.signedUrl, expiresAt: t + SIGNED_URL_SECONDS * 1000 });
      }
    }
    return paths.map((p) => signed.get(p).url);
  }

  const urlFor = async (path) => (await signedUrls([path]))[0];

  async function list(teacherId) {
    const { data, error } = await db
      .from('images')
      .select('id, path, width, height, created_at, last_used_at')
      .eq('teacher_id', teacherId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const urls = data.length > 0 ? await signedUrls(data.map((r) => r.path)) : [];
    return data.map((r, i) => ({
      id: r.id,
      width: r.width,
      height: r.height,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      url: urls[i],
    }));
  }

  // The teacher's own image row, or null (also for another teacher's image).
  async function own(teacherId, imageId) {
    const { data, error } = await db
      .from('images')
      .select('id, path, width, height')
      .eq('id', imageId)
      .eq('teacher_id', teacherId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function upload(teacherId, bytes) {
    const refusal = imageRefusal(bytes);
    if (refusal) return { ok: false, error: refusal };
    const { count, error } = await db.from('images').select('id', { count: 'exact', head: true }).eq('teacher_id', teacherId);
    if (error) throw error;
    if (count >= maxPerTeacher) return { ok: false, error: 'too_many_images' };
    const { width, height } = webpSize(bytes);
    const id = randomUUID();
    const path = imagePath(teacherId, id);
    const stored = await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'image/webp', upsert: false });
    if (stored.error) throw stored.error;
    const row = await db.from('images').insert({ id, teacher_id: teacherId, path, width, height });
    if (row.error) {
      await db.storage.from(BUCKET).remove([path]);
      throw row.error;
    }
    return { ok: true, image: { id, width, height, url: await urlFor(path) } };
  }

  // Refused while an open class uses the picture (checked in memory and in the database).
  async function remove(teacherId, imageId) {
    const image = await own(teacherId, imageId);
    if (!image) return { ok: false, error: 'not_found' };
    const { count, error } = await db
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('image_id', imageId)
      .neq('status', 'ended');
    if (error) throw error;
    if (isOpenUse(imageId) || count > 0) return { ok: false, error: 'image_in_use' };
    const gone = await db.storage.from(BUCKET).remove([image.path]);
    if (gone.error) throw gone.error;
    const row = await db.from('images').delete().eq('id', imageId).eq('teacher_id', teacherId);
    if (row.error) throw row.error;
    signed.delete(image.path);
    return { ok: true };
  }

  async function touch(imageId) {
    const { error } = await db.from('images').update({ last_used_at: new Date(now()).toISOString() }).eq('id', imageId);
    if (error) throw error;
  }

  return { list, own, upload, remove, touch, urlFor };
}
