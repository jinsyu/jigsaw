// Data for 모둠 한눈에 보기 (mockup teacher-overview): the class state the rt server pushes
// (session-live.js) turned into what the screen shows. The model functions are pure
// (unit-tested).
//
// Student names come only from the rt server's roster (its memory, spec D14).
import { buildRoster } from './roster.js';

// The picture to cut the pieces from: a built-in file, or the teacher's own picture through the
// signed URL the server sent with the state, read once into a blob: URL (allowed by img-src
// everywhere, never expires mid-class, and the canvases stay readable).
export async function pictureSource(setup, builtins, fetchImpl = globalThis.fetch) {
  if (setup.builtinKey) {
    const found = builtins.find((b) => b.key === setup.builtinKey);
    if (!found?.src) throw new Error(`unknown built-in picture: ${setup.builtinKey}`);
    return { src: found.src, revoke: () => {} };
  }
  if (!setup.pictureUrl) throw new Error('the class picture has no address');
  const res = await fetchImpl(setup.pictureUrl, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`picture: HTTP ${res.status}`);
  const src = URL.createObjectURL(await res.blob());
  return { src, revoke: () => URL.revokeObjectURL(src) };
}

export const percentOf = (placed, total) => (total > 0 ? Math.floor((placed / total) * 100) : 0);

// Elapsed class time for the clock in the bar: '0:07', '12:34', '1:02:03'.
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Same time in words for screen readers: '12분 34초', '1시간 2분 3초', '7초'.
export function spokenClock(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const parts = [];
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) parts.push(`${h}시간`);
  if (m) parts.push(`${m}분`);
  if (s || parts.length === 0) parts.push(`${s}초`);
  return parts.join(' ');
}

// Columns of the group grid on a wide screen: 6 groups -> 3 x 2 like the mockup.
export function overviewColumns(count) {
  if (count <= 3) return Math.max(1, count);
  if (count === 4) return 2;
  if (count <= 6 || count === 9) return 3;
  return 4;
}

/**
 * @param {object} input
 * @param {string} input.status
 * @param {number|null} input.startedAt   ms, server clock
 * @param {Array} input.groups   server overview groups: { number, empty, completedAt, progress: { placed, total }, clusters }
 * @param {Array} input.members  server roster: { id, name, group, color, online }
 * @param {(memberId: string) => number|null} [input.awayMs]  time offline seen on this page
 */
export function buildOverview({ status = 'playing', startedAt = null, groups: groupsRaw = [], members = [], awayMs = () => null }) {
  const groupRefs = groupsRaw.map((g) => ({ id: g.number, number: g.number }));
  const roster = buildRoster({ members, groups: groupRefs });
  const withAway = (student) => ({ ...student, awayMs: student.online ? null : awayMs(student.id) });

  const groups = groupsRaw.map((g) => {
    const total = g.empty ? 0 : Number(g.progress?.total) || 0;
    const placed = Math.min(total, Number(g.progress?.placed) || 0);
    const completedAt = Number.isFinite(g.completedAt) ? g.completedAt : null;
    const done = total > 0 && (completedAt !== null || placed === total);
    return {
      id: g.number,
      number: g.number,
      total,
      placed,
      percent: done ? 100 : percentOf(placed, total),
      done,
      durationMs: done && completedAt !== null && Number.isFinite(startedAt) ? Math.max(0, completedAt - startedAt) : null,
      clusters: (g.clusters ?? []).map((c) => ({
        id: c.id,
        x: c.x,
        y: c.y,
        locked: c.locked === true,
        heldBy: c.heldBy ?? null,
        pieces: c.pieces ?? [],
      })),
      students: (roster.groups.find((r) => r.id === g.number)?.students ?? []).map(withAway),
    };
  });
  const active = groups.filter((g) => g.total > 0);
  return {
    status,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    groups,
    roster,
    pool: roster.pool.map(withAway),
    activeCount: active.length,
    doneCount: active.filter((g) => g.done).length,
    averagePercent: active.length ? Math.round(active.reduce((sum, g) => sum + g.percent, 0) / active.length) : 0,
  };
}
