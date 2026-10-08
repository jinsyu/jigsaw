// Wording and number helpers for the teacher screens (pure, unit-tested).

// The rt server accepts 1..12 groups (server/src/engine/registry.js).
export const GROUP_COUNT = { min: 1, max: 12, initial: 6 };
export const PIECE_COUNT_INITIAL = 24;
const TYPICAL_GROUP_SIZE = 4;

export function formatCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function piecesPerStudentNote(pieceCount, groupSize = TYPICAL_GROUP_SIZE) {
  const low = Math.floor(pieceCount / groupSize);
  const share = pieceCount % groupSize === 0 ? `${low}` : `${low}~${low + 1}`;
  return `모둠이 ${groupSize}명이면 한 사람에게 ${share}조각씩 나눠 줘요.`;
}

export function clampGroupCount(value) {
  if (value === '' || value === null || value === undefined) return GROUP_COUNT.initial;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return GROUP_COUNT.initial;
  return Math.min(GROUP_COUNT.max, Math.max(GROUP_COUNT.min, n));
}

export function sessionSummary({ title, pieceCount, groupCount }) {
  return `${title} · ${pieceCount}조각 · ${groupCount}모둠`;
}

// Help settings on the create screen (spec rule 10), in screen order.
// short: the name in the summary on the lobby and 내 수업.
export const HINT_OPTIONS = [
  {
    key: 'preview',
    label: '들어갈 칸 미리 보기',
    short: '칸 미리 보기',
    help: '조각을 끌 때 붙을 자리를 초록색으로 알려 줘요. 꺼도 가까이 놓으면 붙어요.',
  },
  {
    key: 'outline',
    label: '틀 안 조각 윤곽선',
    short: '조각 윤곽선',
    help: '판 가운데 틀에 조각 모양 선을 흐리게 그려요. 끄면 바깥 테두리만 보여요.',
  },
  {
    key: 'pictureButton',
    label: '완성 그림 보기 버튼',
    short: '완성 그림 버튼',
    help: '학생이 완성 그림을 작게 열어 볼 수 있어요. 끄면 그림을 보지 않고 맞춰요.',
  },
  {
    key: 'underlay',
    label: '틀 안 흐린 밑그림',
    short: '흐린 밑그림',
    help: '완성 그림을 틀 안에 아주 흐리게 깔아 줘요. 어린 학년에게 알맞아요.',
  },
];

export const onOffLabel = (on) => (on ? '켜짐' : '꺼짐');

// '도움: 조각 윤곽선 · 완성 그림 버튼' (settings that are on), or '도움: 모두 꺼짐'.
export function hintsSummary(hints) {
  const on = HINT_OPTIONS.filter((o) => hints[o.key]).map((o) => o.short);
  return `도움: ${on.length ? on.join(' · ') : '모두 꺼짐'}`;
}

const STATUS_LABELS = { waiting: '학생 기다리는 중', playing: '퍼즐 하는 중', ended: '끝난 수업' };

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? '';
}

export function formatDateTime(iso, timeZone) {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

// Messages for a refused or failed POST /api/sessions (rt-client RtError codes, server/src/http.js).
export function createErrorMessage(error) {
  if (error?.network) return '인터넷 연결을 확인하고 다시 눌러 주세요.';
  if (error?.code === 'invalid_token' || error?.code === 'not_teacher') return '선생님 계정으로 다시 로그인해 주세요.';
  if (error?.code === 'invalid_picture') return '그림을 다시 골라 주세요.';
  if (error?.code === 'too_many_sessions') return '열린 수업이 너무 많아요. 끝난 수업을 닫은 뒤 다시 눌러 주세요.';
  if (error?.code === 'no_free_code' || error?.code === 'shutting_down') return '지금은 수업 코드를 만들 수 없어요. 잠시 뒤 다시 눌러 주세요.';
  return '수업을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.';
}

// The solo practice puzzle (/play?demo=1, play/demo.js) for a built-in picture with the piece
// count and help settings chosen on the create screen, so a teacher can try it before class.
// Teachers' own pictures have no demo (null).
const DEMO_HINT_PARAMS = { preview: 'preview', outline: 'outline', pictureButton: 'button', underlay: 'underlay' };
export function demoUrl({ builtinKey, pieceCount, hints = {} }) {
  if (!builtinKey) return null;
  const params = new URLSearchParams({ demo: '1', picture: builtinKey, pieces: String(pieceCount) });
  for (const [key, param] of Object.entries(DEMO_HINT_PARAMS)) {
    if (typeof hints[key] === 'boolean') params.set(param, hints[key] ? '1' : '0');
  }
  return `/play?${params}`;
}

// '다시 열기' on 내 수업: 새 수업 with the same picture, piece count, group count and help
// settings (read back by presetFromSearch on the create screen).
export function againPath({ builtinKey, imageId, pieceCount, groupCount, hints = {} }) {
  const params = new URLSearchParams();
  if (builtinKey) params.set('picture', builtinKey);
  else if (imageId) params.set('image', imageId);
  params.set('pieces', String(pieceCount));
  params.set('groups', String(groupCount));
  for (const [key, param] of Object.entries(DEMO_HINT_PARAMS)) {
    if (typeof hints[key] === 'boolean') params.set(param, hints[key] ? '1' : '0');
  }
  return `/teacher/new?${params}`;
}

// The choices in a 새 수업 address (anything malformed is left out): { builtinKey?, imageId?,
// pieceCount?, groupCount?, hints }.
export function presetFromSearch(search, pieceCounts) {
  const params = new URLSearchParams(search);
  const preset = { hints: {} };
  const picture = params.get('picture');
  const image = params.get('image');
  if (picture && /^[a-z0-9-]{1,64}$/.test(picture)) preset.builtinKey = picture;
  else if (image && /^[0-9a-f-]{36}$/i.test(image)) preset.imageId = image.toLowerCase();
  const pieces = Number(params.get('pieces'));
  if (pieceCounts.includes(pieces)) preset.pieceCount = pieces;
  const groups = Number(params.get('groups'));
  if (Number.isInteger(groups) && groups >= GROUP_COUNT.min && groups <= GROUP_COUNT.max) preset.groupCount = groups;
  for (const [key, param] of Object.entries(DEMO_HINT_PARAMS)) {
    const value = params.get(param);
    if (value === '1' || value === '0') preset.hints[key] = value === '1';
  }
  return preset;
}
