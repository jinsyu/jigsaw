// Lobby roster (pure): the rt server's student list -> pool and group lists.
//
// Names come only from the rt server (its memory, spec D14) and are shown as sent after
// normalizeName. After a server restart a student has no name until their device connects
// again and sends it (spec D17); such a student is listed as '이름 모름' (numbered when there
// are several, so the teacher can still tell them apart while moving them).
import { normalizeName } from '../student/names.js';

export const UNNAMED = '이름 모름';

/**
 * @typedef {{ id: string, name: string|null, group: number|null, color: number|null, online: boolean }} RosterMember
 *   one entry of the server roster (session.roster(), in joining order)
 * @typedef {{ id: string, name: string|null, label: string, online: boolean, color: number|null, groupId: number|null }} Student
 *   groupId is the group number (groups have no other id in the rt server)
 */

/**
 * @param {object} input
 * @param {RosterMember[]} input.members
 * @param {Array<{ id: number, number: number }>} input.groups  id === number
 */
export function buildRoster({ members, groups }) {
  const unnamedCount = members.filter((m) => !normalizeName(m.name)).length;
  let unnamed = 0;
  const students = members.map((m) => {
    const name = normalizeName(m.name) || null;
    const label = name ?? (unnamedCount > 1 ? `${UNNAMED} ${++unnamed}` : UNNAMED);
    return { id: m.id, name, label, online: m.online === true, color: m.color ?? null, groupId: m.group ?? null };
  });
  const groupIds = new Set(groups.map((g) => g.id));
  // Stable sort: same colour (none yet) keeps the joining order.
  const byColor = (a, b) => (a.color ?? Infinity) - (b.color ?? Infinity);
  return {
    pool: students.filter((s) => s.groupId === null || !groupIds.has(s.groupId)),
    groups: [...groups]
      .sort((a, b) => a.number - b.number)
      .map((g) => ({ id: g.id, number: g.number, students: students.filter((s) => s.groupId === g.id).sort(byColor) })),
    total: students.length,
    onlineCount: students.filter((s) => s.online).length,
  };
}

// Applies a 'groups' event ({ members: [{ id, group, color }] }) to the roster.
// `missing` is true when it names a student we have not heard of (ask for the full state).
export function applyGroupChanges(members, changes) {
  const byId = new Map(changes.map((c) => [c.id, c]));
  const known = new Set(members.map((m) => m.id));
  const next = members.map((m) => {
    const change = byId.get(m.id);
    return change ? { ...m, group: change.group ?? null, color: change.color ?? null } : m;
  });
  return { members: next, missing: [...byId.keys()].some((id) => !known.has(id)) };
}

// Columns for the group boxes on a wide screen: 6 groups -> 3 x 2 like the mockup.
export function groupColumns(count) {
  if (count <= 3) return Math.max(1, count);
  if (count === 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

export function startBlocker(roster) {
  if (roster.total === 0) return '학생이 들어오면 시작할 수 있어요.';
  if (roster.groups.every((g) => g.students.length === 0)) return '학생을 모둠에 넣으면 시작할 수 있어요.';
  return '';
}
