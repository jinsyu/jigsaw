// The built-in pictures as the screens see them (public/images/builtin/index.json), so the
// tests follow the picture set instead of naming counts that change when pictures are added.
import { readFileSync } from 'node:fs';
import { gridFor } from '../../../public/js/puzzle/geometry.js';
import { cardDetail, orderedCategories } from '../../../public/js/teacher/create-view.js';

export const INDEX = JSON.parse(readFileSync(new URL('../../../public/images/builtin/index.json', import.meta.url), 'utf8'));
export const picture = (key) => {
  const found = INDEX.images.find((image) => image.key === key);
  if (!found) throw new Error(`no built-in picture ${key}`);
  return found;
};
// Kinds in chip order and the pictures of each.
export const KINDS = orderedCategories(INDEX.images);
export const ofKind = (kind) => INDEX.images.filter((image) => image.category === kind);
// The picture 새 수업 chooses first: the first of the first chip.
export const FIRST = ofKind(KINDS[0])[0];
export { cardDetail };
export const gridOf = (image, pieces) => gridFor(pieces, image.width / image.height);

// Fixed pictures the tests use: light and wide (3:2-ish, 24 pieces = 6 x 4), exactly 3:2,
// portrait, and a painting with a source line.
export const WIDE = 'nursery-alice';
export const EXACT_3_2 = 'neuschwanstein';
export const TALL = 'cafe-terrace';
