// Built-in pictures (public/images/builtin/index.json, the same file the screens read): the
// server takes the picture aspect from here, not from the request.
import { readFileSync } from 'node:fs';

const INDEX = new URL('../../public/images/builtin/index.json', import.meta.url);
const KEY = /^[a-z0-9-]{1,80}$/;

function toMap({ images }) {
  const map = new Map();
  if (!Array.isArray(images)) return map;
  for (const img of images) {
    const ok = typeof img?.key === 'string' && KEY.test(img.key) && img.width > 0 && img.height > 0;
    if (ok && Number.isFinite(img.width) && Number.isFinite(img.height)) map.set(img.key, { width: img.width, height: img.height });
  }
  return map;
}

export function loadBuiltins(file = INDEX) {
  return toMap(JSON.parse(readFileSync(file, 'utf8')));
}

// Pictures added after this server started are only in the deployed screens' index.json, so
// an unknown key fetches that copy (at most once per minIntervalMs, one fetch at a time) and
// adds what it finds. The local file stays: a picture never disappears while the server runs.
export function createBuiltins({
  local = loadBuiltins(),
  indexUrl,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  minIntervalMs = 60_000,
  timeoutMs = 5_000,
  log = console,
} = {}) {
  const known = new Map(local);
  let lastFetch = -Infinity;
  let inFlight = null;

  async function refresh() {
    lastFetch = now();
    try {
      const res = await fetchImpl(indexUrl, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const [key, size] of toMap(await res.json())) known.set(key, size);
    } catch (error) {
      log.error(`[builtin] 그림 목록을 받지 못했습니다: ${error?.message ?? error}`);
    }
  }

  return {
    async get(key) {
      if (known.has(key)) return known.get(key);
      if (!indexUrl || typeof key !== 'string' || !KEY.test(key)) return undefined;
      if (!inFlight && now() - lastFetch >= minIntervalMs) inFlight = refresh().finally(() => (inFlight = null));
      if (inFlight) await inFlight;
      return known.get(key);
    },
  };
}
