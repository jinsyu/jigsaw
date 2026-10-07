// Student display names. They live only in the rt server's memory and on the student's own
// device (spec D14). Every screen that shows one runs it through normalizeName first, and so
// does the rt server when a name arrives (registry.js, sockets.js).

export const NAME_MAX = 10;

// Control and format characters (bidi overrides, zero-width joiners) would let a name
// hide or reorder the text around it.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/gu;

export function normalizeName(value) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(HIDDEN_CHARS, '').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, NAME_MAX).join('').trim();
}

// Korean particle after a name: withParticle('민준', '을', '를') -> '민준을', '유나' -> '유나를'.
// '으로'/'로' also treats a final ㄹ as no final consonant. Other scripts get both forms.
export function withParticle(word, afterConsonant, afterVowel) {
  const last = word.codePointAt(word.length - 1) ?? 0;
  if (last < 0xac00 || last > 0xd7a3) return `${word}${afterConsonant}(${afterVowel})`;
  const final = (last - 0xac00) % 28;
  const vowelLike = final === 0 || (afterConsonant === '으로' && final === 8);
  return `${word}${vowelLike ? afterVowel : afterConsonant}`;
}
