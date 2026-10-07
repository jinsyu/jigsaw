import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStudentModel } from '../../public/js/student/live.js';
import { MESSAGES, joinReason } from '../../public/js/student/app.js';
import { RtError } from '../../public/js/rt-client.js';

// A student 'state' as server/src/views.js builds it.
function stateOf({ group = 1, status = 'playing', mates, board } = {}) {
  return {
    now: 1_000,
    session: { id: 's1', code: '482913', status, cols: 4, rows: 3, aspect: 4 / 3, seed: 5, builtinKey: 'sea', imageId: null, hints: {}, startedAt: 500, pictureUrl: null },
    me: { memberId: 'm-a', name: '', group, color: 0 },
    group:
      group === null
        ? null
        : {
            number: group,
            mates: mates ?? [
              { id: 'm-a', name: '', color: 0, online: true },
              { id: 'm-b', name: '서‮연', color: 1, online: false },
            ],
            board: board ?? { clusters: [], tray: [0, 1], progress: { placed: 0, total: 12 }, completedAt: null },
          },
  };
}

const grab = { type: 'grab', by: 'm-b', clusterId: 3, z: 2, heldAt: 900 };

describe('createStudentModel', () => {
  it('a state fills in the class, my group, mates (names cleaned, mine from this device) and the board', () => {
    const model = createStudentModel({ memberId: 'm-a', name: '민준' });
    const out = model.applyState(stateOf());
    expect(out.board.tray).toEqual([0, 1]);
    expect(model.state).toMatchObject({ ready: true, status: 'playing', serverNow: 1_000, me: { memberId: 'm-a', name: '민준', group: 1, color: 0 } });
    expect(model.state.mates).toEqual([
      { id: 'm-a', name: '민준', color: 0, online: true, me: true },
      { id: 'm-b', name: '서연', color: 1, online: false, me: false },
    ]);
  });

  it('drops group events before the first state of a connection, passes them on after it', () => {
    const model = createStudentModel({ memberId: 'm-a', name: '민준' });
    expect(model.applyEvents([grab]).events).toEqual([]);
    model.applyState(stateOf());
    expect(model.applyEvents([grab, { type: 'presence' }]).events).toEqual([grab]);
    model.connecting(); // reconnect: the next state has everything
    expect(model.applyEvents([grab]).events).toEqual([]);
  });

  it('a groups event naming me waits for the state that follows; others do not touch me', () => {
    const model = createStudentModel({ memberId: 'm-a', name: '민준' });
    model.applyState(stateOf());
    const other = model.applyEvents([{ type: 'groups', members: [{ id: 'm-x', group: 2, color: 0 }] }, grab]);
    expect(other).toMatchObject({ view: false, events: [grab] });
    const moved = model.applyEvents([{ type: 'groups', members: [{ id: 'm-a', group: 2, color: 3 }] }, grab]);
    expect(moved).toMatchObject({ view: true, events: [] });
    expect(model.state.me).toMatchObject({ group: 2, color: 3 });
    model.applyState(stateOf({ group: 2 }));
    expect(model.applyEvents([grab]).events).toEqual([grab]);
    // Out of every group: no mates, no board events.
    model.applyEvents([{ type: 'groups', members: [{ id: 'm-a', group: null, color: null }] }]);
    expect(model.state.mates).toEqual([]);
    model.applyState(stateOf({ group: null, status: 'playing' }));
    expect(model.applyEvents([grab]).events).toEqual([]);
  });

  it('start waits for the puzzle state; end stops at once', () => {
    const model = createStudentModel({ memberId: 'm-a', name: '민준' });
    model.applyState(stateOf({ status: 'waiting' }));
    const started = model.applyEvents([{ type: 'groups', members: [{ id: 'm-a', group: 1, color: 0 }] }, { type: 'start', startedAt: 9 }, grab]);
    expect(started).toMatchObject({ view: true, events: [], ended: false });
    expect(model.state.status).toBe('playing');
    expect(model.applyEvents([{ type: 'end' }, grab])).toMatchObject({ ended: true, events: [] });
  });

  it('mates of my own group only; rename changes my name everywhere', () => {
    const model = createStudentModel({ memberId: 'm-a', name: '민준' });
    model.applyState(stateOf());
    expect(model.applyMates({ group: 2, mates: [] }).view).toBe(false);
    expect(model.applyMates({ group: 1, mates: [{ id: 'm-a', name: 'x', color: 0, online: false }, { id: 'm-c', name: '지호', color: 2, online: true }] }).view).toBe(true);
    expect(model.state.mates.map((m) => [m.name, m.online])).toEqual([
      ['민준', true],
      ['지호', true],
    ]);
    model.rename('민쥰');
    expect(model.state.me.name).toBe('민쥰');
    expect(model.state.mates[0].name).toBe('민쥰');
  });
});

describe('join messages', () => {
  it('maps the rt server errors to what the student is told', () => {
    expect(MESSAGES[joinReason(new RtError('invalid_code', 404))]).toBe('코드를 다시 확인해 주세요');
    expect(MESSAGES[joinReason(new RtError('too_many_attempts', 429))]).toContain('잠시 뒤에 다시 입력해 주세요');
    expect(joinReason(new RtError('network'))).toBe('network');
    expect(joinReason(new RtError('class_full', 409))).toBe('class_full');
    expect(joinReason(new RtError('rate_limited', 429))).toBe('failed');
    expect(joinReason(new Error('boom'))).toBe('failed');
  });
});

describe('student screens and the Supabase client', () => {
  it('no student module imports supabase-js or the old Supabase store (the rt server answers everything)', () => {
    const root = new URL('../../public/js/', import.meta.url);
    const files = [
      ...readdirSync(new URL('student/', root)).map((f) => `student/${f}`),
      ...readdirSync(new URL('play/', root)).map((f) => `play/${f}`),
      'store/remote-store.js',
      'store/puzzle-store.js',
      'app.js',
    ].filter((f) => f.endsWith('.js'));
    for (const file of files) {
      const text = readFileSync(new URL(file, root), 'utf8');
      expect(text, file).not.toMatch(/supabase-client|supabase-api|@supabase|supabase-js/);
    }
  });
});
