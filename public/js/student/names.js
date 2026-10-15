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

// Words a name may not hold. Checked with spaces, separators and digits taken out, so '바 보'
// and '바1보' count too. Not a full filter: the teacher sees every name on the roster.
// Kept in NFKC like the name they are compared with (NFKC turns 'ㅅ' into a conjoining jamo).
const BANNED_WORDS = ['바보', '멍청', '병신', '븅신', '시발', '씨발', 'ㅅㅂ', 'ㅂㅅ', '개새', '새끼', '죽어', '죽을', '섹스', '야동', 'fuck', 'shit', 'sex'].map(
  (word) => word.normalize('NFKC'),
);
// Ordinary words that hold a banned one; taken out before the check.
const SAFE_WORDS = ['새끼손가락', '새끼발가락', 'essex', 'sussex'].map((word) => word.normalize('NFKC'));

// Contact details and resident registration numbers, checked on an NFKC copy with separators
// removed so full-width digits, '@' and '010-1234-5678' count too. Names are cut at NAME_MAX
// before this check, so the patterns also match what is left of a longer number or address.
const PERSONAL_PATTERNS = [
  /\d{7,}/, // phone number or resident registration number
  /01[016789]\d{3,}/, // the start of a mobile number, e.g. 010-123
  /@/, // e-mail address
];
// A date such as 2026.10.15 or 2026년 10월 15일 is not a phone number.
const DATE = /(?:19|20)\d{2}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}일?/g;
const SEPARATORS = /[\s.\-_()/]/g;

/**
 * Why a normalized name may not be used: 'personal_info' when it looks like a phone number,
 * resident registration number or e-mail address, 'banned_word' when it holds a word on the list,
 * null when it is fine. The screen checks before sending and the rt server checks again.
 * @param {string} name a normalizeName() result
 * @returns {'personal_info' | 'banned_word' | null}
 */
export function nameProblem(name) {
  if (typeof name !== 'string') return null;
  const folded = name.normalize('NFKC').toLowerCase();
  const compact = folded.replace(DATE, '').replace(SEPARATORS, '');
  if (PERSONAL_PATTERNS.some((pattern) => pattern.test(compact))) return 'personal_info';
  let words = folded.replace(SEPARATORS, '');
  for (const safe of SAFE_WORDS) words = words.replaceAll(safe, '');
  words = words.replace(/\d/g, '');
  if (BANNED_WORDS.some((word) => words.includes(word))) return 'banned_word';
  return null;
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
