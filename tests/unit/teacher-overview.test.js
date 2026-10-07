import { describe, expect, it } from 'vitest';
import { buildOverview, formatClock, overviewColumns, percentOf, spokenClock } from '../../public/js/teacher/overview-data.js';
import { createClassState } from '../../public/js/teacher/session-live.js';

const T0 = Date.parse('2026-10-07T09:00:00Z');

// The rt server's overview (session.overview()): 3 groups (2 playing, 1 without students).
function overview() {
  return {
    status: 'playing',
    startedAt: T0,
    groups: [
      {
        number: 1,
        empty: false,
        completedAt: null,
        progress: { placed: 15, total: 24, complete: false },
        clusters: [
          { id: 5, x: 10, y: 20, locked: true, heldBy: null, pieces: [0, 1, 2] },
          { id: 9, x: 400.5, y: 3, locked: false, heldBy: 'm2', pieces: [7] },
        ],
      },
      { number: 2, empty: false, completedAt: T0 + 552_000, progress: { placed: 24, total: 24, complete: true }, clusters: [] },
      { number: 3, empty: true, completedAt: null, progress: null, clusters: [] },
    ],
    members: [
      { id: 'm1', name: '민준', group: 1, color: 1, online: true },
      { id: 'm2', name: '유나', group: 1, color: 0, online: false },
      { id: 'm3', name: '서연', group: 2, color: 0, online: true },
      { id: 'm4', name: '지호', group: null, color: null, online: true },
    ],
  };
}

describe('buildOverview', () => {
  const model = buildOverview({ ...overview(), awayMs: (id) => (id === 'm2' ? 42_000 : null) });

  it('progress per group: placed / total, floored; a finished group is 100% with its time', () => {
    const [one, two, three] = model.groups;
    expect(one).toMatchObject({ id: 1, number: 1, total: 24, placed: 15, percent: 62, done: false, durationMs: null });
    expect(two).toMatchObject({ number: 2, percent: 100, done: true, durationMs: 552_000 });
    expect(three).toMatchObject({ total: 0, percent: 0, done: false });
  });

  it('clusters keep the drawing order and the holder (a member id)', () => {
    expect(model.groups[0].clusters).toEqual([
      { id: 5, x: 10, y: 20, locked: true, heldBy: null, pieces: [0, 1, 2] },
      { id: 9, x: 400.5, y: 3, locked: false, heldBy: 'm2', pieces: [7] },
    ]);
  });

  it('students by colour with names from the server, away time for those not online', () => {
    expect(model.groups[0].students).toEqual([
      { id: 'm2', name: '유나', label: '유나', online: false, color: 0, groupId: 1, awayMs: 42_000 },
      { id: 'm1', name: '민준', label: '민준', online: true, color: 1, groupId: 1, awayMs: null },
    ]);
    expect(model.pool).toEqual([{ id: 'm4', name: '지호', label: '지호', online: true, color: null, groupId: null, awayMs: null }]);
  });

  it('summary counts only groups with a puzzle: done 1 / 2, average progress of those', () => {
    expect(model.activeCount).toBe(2);
    expect(model.doneCount).toBe(1);
    expect(model.averagePercent).toBe(81); // (62 + 100) / 2
    expect(model.startedAt).toBe(T0);
    expect(model.roster.total).toBe(4);
  });

  it('a group whose every piece is locked counts as done even before completedAt arrives', () => {
    const raw = overview();
    raw.groups[0].progress.placed = 24;
    const m = buildOverview(raw);
    expect(m.groups[0]).toMatchObject({ done: true, percent: 100, durationMs: null });
  });

  it('copes with an empty class', () => {
    const m = buildOverview({ status: 'playing', groups: [], members: [] });
    expect(m).toMatchObject({ activeCount: 0, doneCount: 0, averagePercent: 0, pool: [], startedAt: null });
  });
});

describe('createClassState (what the teacher socket receives)', () => {
  function stateMessage(now = T0 + 1000) {
    const o = overview();
    return {
      now,
      session: { id: 's1', code: '123456', status: 'playing', startedAt: T0, pieceCount: 24, hints: {} },
      roster: o.members,
      overview: { status: 'playing', startedAt: T0, groups: o.groups, members: o.members },
    };
  }

  it("'state' replaces everything and sets the server clock", () => {
    let local = T0;
    const c = createClassState({ clock: () => local });
    c.applyState(stateMessage(T0 + 5000));
    expect(c.state).toMatchObject({ ready: true, status: 'playing', startedAt: T0 });
    expect(c.state.members.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(c.state.groups.map((g) => g.number)).toEqual([1, 2, 3]);
    expect(c.serverNow()).toBe(T0 + 5000);
  });

  it('join adds or renames a student, presence and groups update them', () => {
    let local = T0;
    const c = createClassState({ clock: () => local });
    c.applyState(stateMessage());
    c.applyEvent({ type: 'join', member: { id: 'm5', name: '하은', group: null, color: null, online: true } });
    expect(c.state.members.at(-1)).toMatchObject({ id: 'm5', name: '하은' });
    c.applyEvent({ type: 'join', member: { id: 'm2', name: '유나', group: 1, color: 0, online: true } });
    expect(c.state.members.filter((m) => m.id === 'm2')).toHaveLength(1);
    expect(c.applyEvent({ type: 'groups', members: [{ id: 'm5', group: 3, color: 0 }] })).toEqual({ kind: 'roster', needState: false });
    expect(c.state.members.find((m) => m.id === 'm5')).toMatchObject({ group: 3, color: 0 });
    expect(c.applyEvent({ type: 'groups', members: [{ id: 'nobody', group: 1, color: 0 }] }).needState).toBe(true);
  });

  it('counts the time away from the moment this page saw a student leave', () => {
    let local = T0;
    const c = createClassState({ clock: () => local });
    c.applyState(stateMessage());
    expect(c.awayMs('m2')).toBeNull(); // already away when the page opened: unknown since when
    c.applyEvent({ type: 'presence', memberId: 'm1', online: false });
    local += 42_000;
    expect(c.awayMs('m1')).toBe(42_000);
    c.applyEvent({ type: 'presence', memberId: 'm1', online: true });
    expect(c.awayMs('m1')).toBeNull();
  });

  it("'overview' merges the groups that changed and the roster", () => {
    const c = createClassState({ clock: () => T0 });
    c.applyState(stateMessage());
    c.applyOverview({
      now: T0 + 2000,
      status: 'playing',
      startedAt: T0,
      groups: [{ number: 3, empty: false, completedAt: null, progress: { placed: 0, total: 24 }, clusters: [] }],
      members: [...overview().members, { id: 'm5', name: '하은', group: 3, color: 0, online: true }],
    });
    expect(c.state.groups.find((g) => g.number === 3).empty).toBe(false);
    expect(c.state.groups.find((g) => g.number === 1).progress.placed).toBe(15);
    expect(c.state.members).toHaveLength(5);
  });

  it('start and end change the status', () => {
    const c = createClassState({ clock: () => T0 });
    c.applyState({ ...stateMessage(), overview: { ...stateMessage().overview, status: 'waiting', startedAt: null } });
    expect(c.state.status).toBe('waiting');
    expect(c.applyEvent({ type: 'start', startedAt: T0 + 9000 }).kind).toBe('start');
    expect(c.state).toMatchObject({ status: 'playing', startedAt: T0 + 9000 });
    expect(c.applyEvent({ type: 'end' }).kind).toBe('end');
    expect(c.state.status).toBe('ended');
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
});
