// Wording and number helpers for the teacher screens (pure, unit-tested).

// create_session accepts 1..12 groups.
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

const NETWORK_ERROR = /fetch|network|load failed/i;

// Messages for a failed create_session call (error codes: supabase/migrations/*session_flow.sql).
export function createErrorMessage(error) {
  if (error?.code === '42501') return '선생님 계정으로 다시 로그인해 주세요.';
  if (error?.code === '22023') return '그림을 다시 골라 주세요.';
  if (error?.code === '55000') return '지금은 수업 코드를 만들 수 없어요. 잠시 뒤 다시 눌러 주세요.';
  if (!error?.code && NETWORK_ERROR.test(error?.message ?? '')) return '인터넷 연결을 확인하고 다시 눌러 주세요.';
  return '수업을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.';
}
