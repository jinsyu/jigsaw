import { describe, expect, it } from 'vitest';
import { presenceNames } from '../../public/js/student/presence.js';
import { applyGroupChanges, buildRoster, groupColumns, startBlocker } from '../../public/js/teacher/roster.js';

const members = [
  { id: 1, user_id: 'u1', group_id: null, color: null },
  { id: 2, user_id: 'u2', group_id: 10, color: 1 },
  { id: 3, user_id: 'u3', group_id: 10, color: 0 },
  { id: 4, user_id: 'u4', group_id: 11, color: 0 },
];
const groups = [
  { id: 11, number: 2 },
  { id: 10, number: 1 },
];

describe('presenceNames', () => {
  it('accepts a name only when the key and payload match the same members row', () => {
    const state = {
      u1: [{ member: 1, name: ' 민준 ' }],
      u2: [{ member: 3, name: '가짜' }], // payload names another row
      u3: [{ member: '3', name: '서연' }],
      stranger: [{ member: 4, name: '침입자' }],
      u4: [{ member: 4, name: '   ' }],
    };
    const { names, unknownKeys } = presenceNames(state, members);
    expect([...names]).toEqual([
      [1, '민준'],
      [3, '서연'],
    ]);
    expect(unknownKeys).toEqual(['stranger']);
  });

  it('uses the latest entry of a key (second tab)', () => {
    const { names } = presenceNames({ u1: [{ member: 1, name: '민준' }, { member: 1, name: '민준2' }] }, members);
    expect(names.get(1)).toBe('민준2');
  });

  it('copes with an empty or odd state', () => {
    expect(presenceNames(undefined, members).names.size).toBe(0);
    expect(presenceNames({ u1: null }, members).names.size).toBe(0);
  });
});

describe('buildRoster', () => {
  it('splits the pool and the groups, sorts by number and colour, and counts who is online', () => {
    const roster = buildRoster({
      members,
      groups,
      online: new Map([
        [1, '민준'],
        [2, '서연'],
      ]),
      seen: new Map([[3, '지호']]),
    });
    expect(roster.pool.map((s) => s.id)).toEqual([1]);
    expect(roster.groups.map((g) => g.number)).toEqual([1, 2]);
    expect(roster.groups[0].students.map((s) => [s.id, s.name, s.online])).toEqual([
      [3, '지호', false],
      [2, '서연', true],
    ]);
    expect(roster.groups[1].students[0]).toMatchObject({ id: 4, name: null, online: false });
    expect(roster.total).toBe(4);
    expect(roster.onlineCount).toBe(2);
  });
});

describe('applyGroupChanges', () => {
  it('updates group and colour, and flags members it does not know', () => {
    const { members: next, missing } = applyGroupChanges(members, [
      { member_id: 1, group_id: 11, color: 1 },
      { member_id: 2, group_id: null, color: null },
    ]);
    expect(next.find((m) => m.id === 1)).toMatchObject({ group_id: 11, color: 1 });
    expect(next.find((m) => m.id === 2)).toMatchObject({ group_id: null, color: null });
    expect(missing).toBe(false);
    expect(applyGroupChanges(members, [{ member_id: 99, group_id: 10, color: 2 }]).missing).toBe(true);
  });
});

describe('groupColumns and startBlocker', () => {
  it.each([
    [1, 1],
    [3, 3],
    [4, 2],
    [6, 3],
    [9, 3],
    [12, 4],
  ])('%i groups -> %i columns', (n, cols) => expect(groupColumns(n)).toBe(cols));

  it('needs at least one student in a group to start', () => {
    const empty = buildRoster({ members: [], groups, online: new Map(), seen: new Map() });
    expect(startBlocker(empty)).toMatch(/들어오면/);
    const poolOnly = buildRoster({ members: [members[0]], groups, online: new Map(), seen: new Map() });
    expect(startBlocker(poolOnly)).toMatch(/모둠에 넣으면/);
    expect(startBlocker(buildRoster({ members, groups, online: new Map(), seen: new Map() }))).toBe('');
  });
});
