import { describe, expect, it } from 'vitest';
import {
  buildOverview,
  clockOffset,
  formatClock,
  overviewColumns,
  percentOf,
  spokenClock,
} from '../../public/js/teacher/overview-data.js';

const T0 = Date.parse('2026-10-07T09:00:00Z');
const iso = (ms) => new Date(T0 + ms).toISOString();

// session_overview answer: 3 groups (2 playing, 1 without students), 4 students.
function answer() {
  return {
    now: iso(600_000),
    status: 'playing',
    started_at: iso(0),
    ended_at: null,
    groups: [
      {
        id: 11,
        number: 1,
        completed_at: null,
        total: 24,
        placed: 15,
        clusters: [
          { id: 5, x: 10, y: 20, locked: true, held_by: null, pieces: [0, 1, 2] },
          { id: 9, x: 400.5, y: 3, locked: false, held_by: 'u2', pieces: [7] },
        ],
      },
      { id: 12, number: 2, completed_at: iso(552_000), total: 24, placed: 24, clusters: [] },
      { id: 13, number: 3, completed_at: null, total: 0, placed: 0, clusters: [] },
    ],
    members: [
      { id: 1, user_id: 'u1', group_id: 11, color: 1, last_seen: iso(598_000) },
      { id: 2, user_id: 'u2', group_id: 11, color: 0, last_seen: iso(558_000) },
      { id: 3, user_id: 'u3', group_id: 12, color: 0, last_seen: iso(599_000) },
      { id: 4, user_id: 'u4', group_id: null, color: null, last_seen: iso(599_500) },
    ],
  };
}

describe('buildOverview', () => {
  const online = new Map([
    [1, '민준'],
    [3, '서연'],
    [4, '지호'],
  ]);
  const seen = new Map([[2, '유나']]);
  const model = buildOverview(answer(), { online, seen, serverNow: T0 + 600_000 });

  it('progress per group: placed / total, floored; a finished group is 100% with its time', () => {
    const [one, two, three] = model.groups;
    expect(one).toMatchObject({ number: 1, total: 24, placed: 15, percent: 62, done: false, durationMs: null });
    expect(two).toMatchObject({ number: 2, percent: 100, done: true, durationMs: 552_000 });
    expect(three).toMatchObject({ total: 0, percent: 0, done: false });
  });

  it('clusters keep the drawing order and the holder', () => {
    expect(model.groups[0].clusters).toEqual([
      { id: 5, x: 10, y: 20, locked: true, heldBy: null, pieces: [0, 1, 2] },
      { id: 9, x: 400.5, y: 3, locked: false, heldBy: 'u2', pieces: [7] },
    ]);
  });

  it('students by colour with names from Presence (or remembered), away time for those not online', () => {
    expect(model.groups[0].students).toEqual([
      { id: 2, name: '유나', online: false, color: 0, groupId: 11, awayMs: 42_000 },
      { id: 1, name: '민준', online: true, color: 1, groupId: 11, awayMs: null },
    ]);
    expect(model.pool).toEqual([{ id: 4, name: '지호', online: true, color: null, groupId: null, awayMs: null }]);
  });

  it('summary counts only groups with a puzzle: done 1 / 2, average progress of those', () => {
    expect(model.activeCount).toBe(2);
    expect(model.doneCount).toBe(1);
    expect(model.averagePercent).toBe(81); // (62 + 100) / 2
    expect(model.startedAt).toBe(T0);
    expect(model.roster.total).toBe(4);
  });

  it('a group whose every piece is locked counts as done even before completed_at arrives', () => {
    const raw = answer();
    raw.groups[0].placed = 24;
    const m = buildOverview(raw, { online, seen, serverNow: T0 });
    expect(m.groups[0]).toMatchObject({ done: true, percent: 100, durationMs: null });
  });

  it('copes with an empty answer (ended class: no members)', () => {
    const m = buildOverview({ status: 'ended', groups: [], members: [] }, { online: new Map(), seen: new Map(), serverNow: 0 });
    expect(m).toMatchObject({ status: 'ended', activeCount: 0, doneCount: 0, averagePercent: 0, pool: [] });
  });
});

describe('clock and layout helpers', () => {
  it('formatClock: m:ss under an hour, h:mm:ss after', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7_900)).toBe('0:07');
    expect(formatClock(754_000)).toBe('12:34');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });

  it('spokenClock reads the same time in words', () => {
    expect(spokenClock(754_000)).toBe('12분 34초');
    expect(spokenClock(3_723_000)).toBe('1시간 2분 3초');
    expect(spokenClock(0)).toBe('0초');
    expect(spokenClock(120_000)).toBe('2분');
  });

  it('percentOf floors (100% only when all pieces are in)', () => {
    expect(percentOf(23, 24)).toBe(95);
    expect(percentOf(69, 70)).toBe(98);
    expect(percentOf(0, 0)).toBe(0);
  });

  it('overviewColumns: 6 groups in 3 x 2 like the mockup', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map(overviewColumns)).toEqual([1, 2, 3, 2, 3, 3, 4, 4, 3, 4, 4]);
  });

  it('clockOffset: server time minus the middle of the call', () => {
    expect(clockOffset(new Date(10_500).toISOString(), 1000, 2000)).toBe(9000);
    expect(clockOffset('nonsense', 0, 0)).toBe(0);
  });
});
