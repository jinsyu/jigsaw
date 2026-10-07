// Pictures a session can use: built-in pictures (static files) and the teacher's own pictures
// (private Storage bucket; the rt server lists them with short-lived signed URLs).

const BUILTIN_INDEX = '/images/builtin/index.json';

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

// [{ id, width, height, createdAt, lastUsedAt, url }], newest first (GET /api/images).
export async function loadMyImages(api) {
  const { images } = await api.get('/api/images');
  return images;
}

// What to show for a session's picture: { title, thumb } (thumb may be null).
export function sessionPicture(session, builtins, myImages = []) {
  if (session.builtinKey) {
    const builtin = builtins.find((b) => b.key === session.builtinKey);
    return { title: builtin?.title ?? '그림', thumb: builtin?.thumb ?? null };
  }
  const mine = myImages.find((i) => i.id === session.imageId);
  return { title: '내 그림', thumb: mine?.url ?? null };
}
