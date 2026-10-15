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

// Real-name check: a common surname and one or two given-name syllables, all Hangul.
const SURNAMES = new Set([...'김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우구민류나진지엄채원천방공현함변염여추도소석선설마길연위표명기반']);
const COMPOUND_SURNAMES = ['남궁', '황보', '제갈', '선우', '독고', '사공', '서문'];
// Syllables common in given names. '아', '이', '양' and the like are left out because ordinary
// words (강아지, 고양이) are full of them.
const GIVEN_NAME_SYLLABLES = new Set([
  ...'민서준현지수우윤도하은예연유진영재성호원희경빈린율인혜정주채태훈석규혁철동승세소시나다라리미보상선슬온완용욱찬창형효휘건결겸담람랑로루솔환후웅범',
]);
// Surname-and-name shaped, but ordinary words children use as nicknames.
const COMMON_WORDS = new Set(['구미호', '오리온', '오소리', '지하철', '우주선', '도라지', '유리수', '원주민']);

const isGivenName = (text) => text.length >= 1 && text.length <= 2 && [...text].every((c) => GIVEN_NAME_SYLLABLES.has(c));

/**
 * True when the name looks like a Korean real name: surname + one or two given-name syllables
 * (three Hangul in all, up to four with a two-syllable surname). Spaces and trailing digits are
 * ignored; one syllable repeated (하하하) and COMMON_WORDS are not names. A two-syllable name
 * without a surname (민준) cannot be told from a nickname and passes.
 * @param {string} value
 */
export function looksLikeRealName(value) {
  if (typeof value !== 'string') return false;
  const name = value.normalize('NFC').replace(/\s/g, '').replace(/\d+$/, '');
  if (!/^[가-힣]+$/.test(name) || COMMON_WORDS.has(name)) return false;
  if (new Set(name).size === 1) return false;
  const compound = COMPOUND_SURNAMES.find((surname) => name.startsWith(surname));
  if (compound) return isGivenName(name.slice(compound.length));
  return name.length === 3 && SURNAMES.has(name[0]) && isGivenName(name.slice(1));
}

/**
 * Why a normalized name may not be used: 'personal_info' when it looks like a phone number,
 * resident registration number or e-mail address, 'real_name' when it looks like a real name,
 * 'banned_word' when it holds a word on the list, null when it is fine. The screen checks before
 * sending and the rt server checks again.
 * @param {string} name a normalizeName() result
 * @returns {'personal_info' | 'real_name' | 'banned_word' | null}
 */
export function nameProblem(name) {
  if (typeof name !== 'string') return null;
  const folded = name.normalize('NFKC').toLowerCase();
  const compact = folded.replace(DATE, '').replace(SEPARATORS, '');
  if (PERSONAL_PATTERNS.some((pattern) => pattern.test(compact))) return 'personal_info';
  if (looksLikeRealName(name)) return 'real_name';
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
