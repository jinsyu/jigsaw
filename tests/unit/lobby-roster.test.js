import { describe, expect, it } from 'vitest';
import { presenceNames } from '../../public/js/student/presence.js';
import { UNNAMED, applyGroupChanges, buildRoster, groupColumns, startBlocker } from '../../public/js/teacher/roster.js';

// presenceNames: the student screens' Presence (until T22).
const members = [
  { id: 1, user_id: 'u1' },
  { id: 2, user_id: 'u2' },
  { id: 3, user_id: 'u3' },
  { id: 4, user_id: 'u4' },
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

// The rt server's roster (session.roster()): joining order, names from its memory.
const roster = [
  { id: 'm-a', name: '민준', group: null, color: null, online: true },
  { id: 'm-b', name: '서연', group: 1, color: 1, online: true },
  { id: 'm-c', name: '지호', group: 1, color: 0, online: false },
  { id: 'm-d', name: '', group: 2, color: 0, online: false }, // restored after a restart, not back yet
];
const groups = [
  { id: 2, number: 2 },
  { id: 1, number: 1 },
];

describe('buildRoster', () => {
  it('splits the pool and the groups, sorts by number and colour, and counts who is online', () => {
    const r = buildRoster({ members: roster, groups });
    expect(r.pool.map((s) => s.id)).toEqual(['m-a']);
    expect(r.groups.map((g) => g.number)).toEqual([1, 2]);
    expect(r.groups[0].students.map((s) => [s.id, s.label, s.online])).toEqual([
      ['m-c', '지호', false],
      ['m-b', '서연', true],
    ]);
    expect(r.total).toBe(4);
    expect(r.onlineCount).toBe(2);
  });

  it('lists a student without a name (server restarted, device not back yet) as 이름 모름', () => {
    const r = buildRoster({ members: roster, groups });
    expect(r.groups[1].students[0]).toMatchObject({ id: 'm-d', name: null, label: UNNAMED, online: false });
  });

  it('numbers several students without a name so the teacher can tell them apart', () => {
    const r = buildRoster({
      members: [
        { id: 'x', name: null, group: null, color: null, online: false },
        { id: 'y', name: '하은', group: null, color: null, online: true },
        { id: 'z', name: ' ', group: null, color: null, online: false },
      ],
      groups,
    });
    expect(r.pool.map((s) => s.label)).toEqual([`${UNNAMED} 1`, '하은', `${UNNAMED} 2`]);
  });

  it('cleans names again (hidden characters, length)', () => {
    const r = buildRoster({ members: [{ id: 'q', name: '\u202e가나다라마바사아자차카타', group: null, color: null, online: true }], groups });
    expect(r.pool[0].label).toBe('가나다라마바사아자차');
  });
});

describe('applyGroupChanges', () => {
  it('updates group and colour, and flags members it does not know', () => {
    const { members: next, missing } = applyGroupChanges(roster, [
      { id: 'm-a', group: 2, color: 1 },
      { id: 'm-b', group: null, color: null },
    ]);
    expect(next.find((m) => m.id === 'm-a')).toMatchObject({ group: 2, color: 1 });
    expect(next.find((m) => m.id === 'm-b')).toMatchObject({ group: null, color: null });
    expect(missing).toBe(false);
    expect(applyGroupChanges(roster, [{ id: 'm-zz', group: 1, color: 2 }]).missing).toBe(true);
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
    expect(startBlocker(buildRoster({ members: [], groups }))).toMatch(/들어오면/);
    expect(startBlocker(buildRoster({ members: [roster[0]], groups }))).toMatch(/모둠에 넣으면/);
    expect(startBlocker(buildRoster({ members: roster, groups }))).toBe('');
  });
});
