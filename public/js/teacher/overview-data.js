// Data for 모둠 한눈에 보기 (mockup teacher-overview): one session_overview read every
// POLL_MS (spec: the teacher polls instead of listening to every group channel), turned into
// what the screen shows. The model functions are pure (unit-tested).
//
// Student names come only from Presence (student/presence.js) and the page's memory (D14);
// the server sends member rows without names.
import { buildRoster } from './roster.js';
import { IMAGE_BUCKET } from '../supabase-names.js';

export const POLL_MS = 3000;
// A student out of Presence for this long has had the tray dealt to the others (T6: 1 minute).
export const TRAY_DEALT_MS = 60_000;

// Grid, picture aspect and shape seed: the same on every device (geometry.js). session_setup
// returns the aspect exactly (a plain select would round it to 15 digits).
export async function getPuzzleSetup(client, sessionId) {
  const { data, error } = await client.rpc('session_setup', { p_session: sessionId });
  if (error) throw error;
  if (!data) throw new Error(`session ${sessionId} is not readable`);
  return { cols: data.cols, rows: data.rows, aspect: data.aspect, seed: Number(data.seed) };
}

export async function fetchOverview(client, sessionId) {
  const { data, error } = await client.rpc('session_overview', { p_session: sessionId });
  if (error) throw error;
  return data;
}

// The picture to cut the pieces from: a built-in file, or the teacher's own picture from the
// private bucket as a blob: URL (allowed by img-src everywhere, never expires mid-class).
export async function pictureSource(client, session, builtins) {
  if (session.builtin_key) {
    const found = builtins.find((b) => b.key === session.builtin_key);
    if (!found?.src) throw new Error(`unknown built-in picture: ${session.builtin_key}`);
    return { src: found.src, revoke: () => {} };
  }
  if (!session.image_id) throw new Error('the session has no picture');
  const { data: image, error } = await client.from('images').select('path').eq('id', session.image_id).maybeSingle();
  if (error) throw error;
  if (!image) throw new Error('the picture is not readable');
  const { data: blob, error: downloadError } = await client.storage.from(IMAGE_BUCKET).download(image.path);
  if (downloadError) throw downloadError;
  const src = URL.createObjectURL(blob);
  return { src, revoke: () => URL.revokeObjectURL(src) };
}

// Server ms - local ms, from the server time in an answer and the local times around the call.
export function clockOffset(serverIso, sentAt, receivedAt) {
  const server = Date.parse(serverIso);
  return Number.isFinite(server) ? server - (sentAt + receivedAt) / 2 : 0;
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
 * @param {object} raw  session_overview answer
 * @param {object} input
 * @param {Map<number, string>} input.online  names of members online now (presenceNames)
 * @param {Map<number, string>} input.seen    last name seen per member (this page only)
 * @param {number} input.serverNow            ms, server clock
 */
export function buildOverview(raw, { online, seen, serverNow }) {
  const groupsRaw = raw?.groups ?? [];
  const members = (raw?.members ?? []).map((m) => ({
    id: Number(m.id),
    user_id: m.user_id,
    group_id: m.group_id === null || m.group_id === undefined ? null : Number(m.group_id),
    color: m.color ?? null,
    lastSeen: Date.parse(m.last_seen),
  }));
  const roster = buildRoster({
    members,
    groups: groupsRaw.map((g) => ({ id: Number(g.id), number: g.number })),
    online,
    seen,
  });
  const lastSeen = new Map(members.map((m) => [m.id, m.lastSeen]));
  const withAway = (student) => ({
    ...student,
    awayMs: student.online || !Number.isFinite(lastSeen.get(student.id)) ? null : Math.max(0, serverNow - lastSeen.get(student.id)),
  });
  const startedAt = raw?.started_at ? Date.parse(raw.started_at) : null;

  const groups = groupsRaw.map((g) => {
    const id = Number(g.id);
    const total = Number(g.total) || 0;
    const placed = Math.min(total, Number(g.placed) || 0);
    const completedAt = g.completed_at ? Date.parse(g.completed_at) : null;
    const done = total > 0 && (completedAt !== null || placed === total);
    return {
      id,
      number: g.number,
      total,
      placed,
      percent: done ? 100 : percentOf(placed, total),
      done,
      durationMs: done && completedAt !== null && startedAt !== null ? Math.max(0, completedAt - startedAt) : null,
      clusters: (g.clusters ?? []).map((c) => ({
        id: Number(c.id),
        x: c.x,
        y: c.y,
        locked: c.locked === true,
        heldBy: c.held_by ?? null,
        pieces: c.pieces ?? [],
      })),
      students: (roster.groups.find((r) => r.id === id)?.students ?? []).map(withAway),
    };
  });
  const active = groups.filter((g) => g.total > 0);
  return {
    status: raw?.status ?? 'playing',
    startedAt,
    groups,
    members,
    roster,
    pool: roster.pool.map(withAway),
    activeCount: active.length,
    doneCount: active.filter((g) => g.done).length,
    averagePercent: active.length ? Math.round(active.reduce((sum, g) => sum + g.percent, 0) / active.length) : 0,
  };
}
