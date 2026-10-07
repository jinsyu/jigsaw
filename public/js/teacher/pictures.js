// Pictures a session can use: built-in pictures (static files) and the teacher's
// own pictures (private Storage bucket, read through short-lived signed URLs).

const BUILTIN_INDEX = '/images/builtin/index.json';
const SIGNED_URL_SECONDS = 60 * 60;

let builtinsPromise = null;

export function loadBuiltins() {
  builtinsPromise ??= fetch(BUILTIN_INDEX)
    .then((res) => {
      if (!res.ok) throw new Error(`built-in pictures: HTTP ${res.status}`);
      return res.json();
    })
    .then((index) => index.images)
    .catch((error) => {
      builtinsPromise = null; // let the next attempt try again
      throw error;
    });
  return builtinsPromise;
}

export async function loadMyImages(client) {
  const { data: rows, error } = await client
    .from('images')
    .select('id, path, width, height, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!rows.length) return [];
  const { data: signed, error: signError } = await client.storage
    .from('images')
    .createSignedUrls(rows.map((r) => r.path), SIGNED_URL_SECONDS);
  if (signError) throw signError;
  const urlByPath = new Map(signed.map((s) => [s.path, s.signedUrl]));
  return rows.map((r) => ({ ...r, url: urlByPath.get(r.path) ?? null }));
}

// What to show for a session's picture: { title, thumb } (thumb may be null).
export function sessionPicture(session, builtins, myImages = []) {
  if (session.builtin_key) {
    const builtin = builtins.find((b) => b.key === session.builtin_key);
    return { title: builtin?.title ?? '그림', thumb: builtin?.thumb ?? null };
  }
  const mine = myImages.find((i) => i.id === session.image_id);
  return { title: '내 그림', thumb: mine?.url ?? null };
}
