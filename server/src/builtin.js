// Built-in pictures (public/images/builtin/index.json, the same file the screens read): the
// server takes the picture aspect from here, not from the request.
import { readFileSync } from 'node:fs';

const INDEX = new URL('../../public/images/builtin/index.json', import.meta.url);

export function loadBuiltins(file = INDEX) {
  const { images } = JSON.parse(readFileSync(file, 'utf8'));
  return new Map(images.map((img) => [img.key, { width: img.width, height: img.height }]));
}
