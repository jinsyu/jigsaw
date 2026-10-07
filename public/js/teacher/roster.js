// Lobby roster (pure): members rows + names seen in Presence -> pool and group lists.

/**
 * @typedef {{ id: number, user_id: string, group_id: number|null, color: number|null }} MemberRow
 * @typedef {{ id: number, name: string|null, online: boolean, color: number|null, groupId: number|null }} Student
 */

const byColorThenId = (a, b) => (a.color ?? Infinity) - (b.color ?? Infinity) || a.id - b.id;

/**
 * @param {object} input
 * @param {MemberRow[]} input.members
 * @param {Array<{ id: number, number: number }>} input.groups
 * @param {Map<number, string>} input.online  names of members online now (presenceNames)
 * @param {Map<number, string>} input.seen    last name seen for members that left (screen memory only)
 */
export function buildRoster({ members, groups, online, seen }) {
  const students = members.map((m) => ({
    id: m.id,
    name: online.get(m.id) ?? seen.get(m.id) ?? null,
    online: online.has(m.id),
    color: m.color,
    groupId: m.group_id,
  }));
  const groupIds = new Set(groups.map((g) => g.id));
  return {
    pool: students.filter((s) => s.groupId === null || !groupIds.has(s.groupId)).sort((a, b) => a.id - b.id),
    groups: [...groups]
      .sort((a, b) => a.number - b.number)
      .map((g) => ({ id: g.id, number: g.number, students: students.filter((s) => s.groupId === g.id).sort(byColorThenId) })),
    total: students.length,
    onlineCount: students.filter((s) => s.online).length,
  };
}

// Applies a 'groups' broadcast ({ members: [{ member_id, group_id, color }] }).
// `missing` is true when it names a member we have not read yet (read the members again).
export function applyGroupChanges(members, changes) {
  const byId = new Map(changes.map((c) => [Number(c.member_id), c]));
  const known = new Set(members.map((m) => m.id));
  const next = members.map((m) => {
    const change = byId.get(m.id);
    return change ? { ...m, group_id: change.group_id ?? null, color: change.color ?? null } : m;
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
