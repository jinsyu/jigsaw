// T16: class flow engine (create, join, groups, start, moves, end) and the registry of open
// classes. Pure logic: clock, randomness, ids and tokens are injected.
import { describe, expect, it } from 'vitest';
import { rng } from '../../public/js/puzzle/geometry.js';
import { createRegistry, hashToken } from '../../server/src/engine/registry.js';

const T0 = Date.parse('2026-10-09T09:00:00.000Z');
const BUILTIN = { builtinKey: 'sea-turtle', aspect: 4 / 3 };

function makeRegistry(options = {}) {
  let t = T0;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  let ids = 0;
  let tokens = 0;
  const next = rng(5);
  const registry = createRegistry({
    now,
    random: rng(9),
    randomInt: (min, max) => min + Math.floor(next() * (max - min)),
    newId: () => `m${++ids}`,
    newToken: () => `token-${++tokens}`,
    ...options,
  });
  return { registry, now };
}

function openClass(registry, overrides = {}) {
  const { result } = registry.createSession('teacher-1', {
    pieceCount: 24,
    groupCount: 3,
    picture: BUILTIN,
    ...overrides,
  });
  expect(result.ok).toBe(true);
  return registry.session(result.sessionId);
}

function joinMany(registry, session, names) {
  return names.map((name) => {
    const { result } = registry.join(session.code, { name });
    expect(result.ok).toBe(true);
    return result;
  });
}

const types = (events) => events.map((e) => e.type);

describe('수업 만들기', () => {
  it('조각 수·그림 비율로 격자를 정하고, 6자리 코드·시드·모둠·도움 설정을 갖는다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry, { hints: { preview: true } });
    const record = session.toRecord();
    expect(record).toMatchObject({
      teacherId: 'teacher-1',
      status: 'waiting',
      pieceCount: 24,
      cols: 6,
      rows: 4,
      aspect: 4 / 3,
      builtinKey: 'sea-turtle',
      imageId: null,
      hints: { preview: true, outline: true, pictureButton: true, underlay: false },
      createdAt: T0,
      startedAt: null,
    });
    expect(record.code).toMatch(/^\d{6}$/);
    expect(Number.isInteger(record.seed) && record.seed > 0).toBe(true);
    expect(record.groups.map((g) => g.number)).toEqual([1, 2, 3]);
  });

  it('교사 그림은 가로·세로로 비율을 정한다 (세로 그림은 열이 짧은 쪽)', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry, { pieceCount: 12, picture: { imageId: 'img-1', width: 900, height: 1600 } });
    expect(session.toRecord()).toMatchObject({ imageId: 'img-1', builtinKey: null, aspect: 900 / 1600, cols: 3, rows: 4 });
  });

  it.each([
    [{ pieceCount: 25 }, 'invalid_piece_count'],
    [{ groupCount: 0 }, 'invalid_group_count'],
    [{ groupCount: 13 }, 'invalid_group_count'],
    [{ picture: { builtinKey: 'Bad Key', aspect: 1 } }, 'invalid_picture'],
    [{ picture: { builtinKey: 'ok', aspect: 0 } }, 'invalid_picture'],
    [{ picture: { imageId: 'img', width: 0, height: 10 } }, 'invalid_picture'],
    [{ picture: { builtinKey: 'ok', aspect: 1, imageId: 'img' } }, 'invalid_picture'],
  ])('잘못된 입력 %j 은 %s', (overrides, error) => {
    const { registry } = makeRegistry();
    const { result, events } = registry.createSession('teacher-1', { pieceCount: 24, groupCount: 3, picture: BUILTIN, ...overrides });
    expect(result).toEqual({ ok: false, error });
    expect(events).toEqual([]);
  });

  it('열린 수업끼리 코드가 겹치지 않는다 (같은 수가 나와도 다시 뽑는다)', () => {
    const draws = [123456, 123456, 123456, 654321];
    const { registry } = makeRegistry({ randomInt: (min, max) => (max === 1_000_000 ? draws.shift() ?? 1 : min + 1) });
    const first = openClass(registry);
    const second = openClass(registry);
    expect(first.code).toBe('123456');
    expect(second.code).toBe('654321');
  });

  it('끝난 수업의 코드는 다시 쓸 수 있다', () => {
    const draws = [111111, 111111];
    const { registry } = makeRegistry({ randomInt: (min, max) => (max === 1_000_000 ? draws.shift() : min + 1) });
    const first = openClass(registry);
    registry.end(first.id);
    expect(openClass(registry).code).toBe('111111');
  });

  it('빈 코드를 못 찾으면 no_free_code', () => {
    const { registry } = makeRegistry({ randomInt: (min, max) => (max === 1_000_000 ? 7 : min + 1) });
    openClass(registry);
    expect(registry.createSession('teacher-1', { pieceCount: 24, groupCount: 3, picture: BUILTIN }).result).toEqual({
      ok: false,
      error: 'no_free_code',
    });
  });

  it('열린 수업 수 상한을 넘으면 거부한다', () => {
    const { registry } = makeRegistry({ maxOpenSessions: 2 });
    const first = openClass(registry);
    openClass(registry);
    const third = registry.createSession('teacher-1', { pieceCount: 24, groupCount: 3, picture: BUILTIN });
    expect(third.result).toEqual({ ok: false, error: 'too_many_sessions' });
    registry.end(first.id);
    expect(registry.createSession('teacher-1', { pieceCount: 24, groupCount: 3, picture: BUILTIN }).result.ok).toBe(true);
  });
});

describe('학생 입장 (D3)', () => {
  it('코드와 이름으로 들어오면 member id·토큰을 받고, 교사에게 이름이 간다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    const { result, events } = registry.join(session.code, { name: '  민준 ' });
    expect(result).toEqual({
      ok: true,
      sessionId: session.id,
      memberId: expect.any(String),
      token: 'token-1',
      status: 'waiting',
      group: null,
      color: null,
    });
    expect(events).toEqual([
      { to: 'teacher', type: 'join', member: { id: result.memberId, name: '민준', group: null, color: null, online: false } },
    ]);
    expect(registry.byToken('token-1')).toMatchObject({ session: { id: session.id }, memberId: result.memberId });
  });

  it('엔진에는 토큰 원문이 아니라 해시만 남는다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    registry.join(session.code, { name: '민준' });
    const record = JSON.stringify(session.toRecord());
    expect(record).not.toContain('token-1');
    expect(session.toRecord().members[0].tokenHash).toBe(hashToken('token-1'));
  });

  it.each(['000000', '', '12345', null])('틀린 코드 %j 는 invalid_code', (code) => {
    const { registry } = makeRegistry();
    openClass(registry);
    expect(registry.join(code, { name: '민준' })).toEqual({ result: { ok: false, error: 'invalid_code' }, events: [] });
  });

  it('이름이 비면 invalid_name', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    expect(registry.join(session.code, { name: ' ​ ' }).result).toEqual({ ok: false, error: 'invalid_name' });
  });

  it('같은 토큰으로 다시 들어오면 같은 member 로 돌아오고, 이름을 다시 채운다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    const first = registry.join(session.code, { name: '민준' }).result;
    session.assign(first.memberId, 2);
    const again = registry.join(session.code, { name: '민준이', token: first.token });
    expect(again.result).toMatchObject({ ok: true, memberId: first.memberId, token: first.token, group: 2 });
    expect(session.roster()).toHaveLength(1);
    expect(session.roster()[0].name).toBe('민준이');
  });

  it('모르는 토큰이면 새 학생으로 들어온다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    const { result } = registry.join(session.code, { name: '민준', token: 'from-another-class' });
    expect(result.ok).toBe(true);
    expect(result.token).toBe('token-1');
    expect(session.roster()).toHaveLength(1);
  });
});

describe('모둠 편성·시작 (D4, D5)', () => {
  it('교사가 모둠에 넣으면 그 모둠에서 비어 있는 가장 작은 색을 받는다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    const [a, b] = joinMany(registry, session, ['가', '나']);
    expect(session.assign(a.memberId, 1).events).toEqual([
      { to: 'session', type: 'groups', members: [{ id: a.memberId, group: 1, color: 0 }] },
    ]);
    session.assign(b.memberId, 1);
    expect(session.roster().map((m) => [m.group, m.color])).toEqual([[1, 0], [1, 1]]);
    session.assign(a.memberId, null);
    expect(session.roster()[0]).toMatchObject({ group: null, color: null });
  });

  it('없는 모둠·없는 학생은 거부한다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    const [a] = joinMany(registry, session, ['가']);
    expect(session.assign(a.memberId, 4).result).toEqual({ ok: false, error: 'invalid_group' });
    expect(session.assign('nobody', 1).result).toEqual({ ok: false, error: 'member_not_found' });
  });

  it('무작위로 나누면 모둠 크기가 최대 1 차이 나고, 모두 모둠에 들어간다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    joinMany(registry, session, ['1', '2', '3', '4', '5', '6', '7']);
    const { result, events } = session.randomize();
    expect(result.ok).toBe(true);
    expect(types(events)).toEqual(['groups']);
    const sizes = [1, 2, 3].map((g) => session.roster().filter((m) => m.group === g).length);
    expect(sizes.sort()).toEqual([2, 2, 3]);
    for (const g of [1, 2, 3]) {
      const colors = session.roster().filter((m) => m.group === g).map((m) => m.color).sort();
      expect(colors).toEqual(Array.from({ length: colors.length }, (_, i) => i));
    }
  });

  it('시작하면 학생이 있는 모둠마다 판을 만들고 조각을 고르게 나눈다 (24조각·5명 → 5·5·5·5·4)', () => {
    const { registry, now } = makeRegistry();
    const session = openClass(registry, { groupCount: 2 });
    const students = joinMany(registry, session, ['1', '2', '3', '4', '5']);
    for (const s of students) session.assign(s.memberId, 1);
    now.advance(1000);
    const { result, events } = session.start();
    expect(result).toEqual({ ok: true, startedAt: T0 + 1000 });
    expect(types(events)).toEqual(['groups', 'start']);
    const record = session.toRecord();
    expect(record.status).toBe('playing');
    const trays = record.groups[0].board.trays;
    expect(Object.values(trays).map((t) => t.length).sort((x, y) => y - x)).toEqual([5, 5, 5, 5, 4]);
    expect(record.groups[1].board).toBeNull();
    expect(session.overview().groups[1]).toMatchObject({ number: 2, empty: true });
    expect(session.start().result).toEqual({ ok: false, error: 'session_not_waiting' });
    expect(session.randomize().result).toEqual({ ok: false, error: 'session_not_waiting' });
  });

  it('시작할 때 색은 들어온 순서대로 0부터 다시 매긴다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    const [a, b, c] = joinMany(registry, session, ['가', '나', '다']);
    session.assign(c.memberId, 1);
    session.assign(a.memberId, 1);
    session.assign(b.memberId, 1);
    session.assign(c.memberId, null);
    session.assign(c.memberId, 1);
    session.start();
    expect(session.roster().map((m) => m.color)).toEqual([0, 1, 2]);
  });
});

describe('시작 후 처리', () => {
  function playing() {
    const ctx = makeRegistry();
    const session = openClass(ctx.registry);
    const students = joinMany(ctx.registry, session, ['가', '나', '다']);
    session.assign(students[0].memberId, 1);
    session.assign(students[1].memberId, 1);
    session.assign(students[2].memberId, 2);
    for (const s of students) session.memberOnline(s.memberId);
    session.start();
    return { ...ctx, session, students };
  }

  const trays = (session, group) => session.toRecord().groups[group - 1].board?.trays ?? null;

  it('시작 후 들어온 학생은 모둠 밖에서 기다리고, 넣으면 상자 없이 판 위 조각만 만진다', () => {
    const { registry, session } = playing();
    const late = registry.join(session.code, { name: '라' }).result;
    expect(late).toMatchObject({ status: 'playing', group: null });
    session.memberOnline(late.memberId);
    const { result } = session.assign(late.memberId, 1);
    expect(result.ok).toBe(true);
    expect(trays(session, 1)[late.memberId]).toEqual([]);
    expect(session.roster().find((m) => m.id === late.memberId).color).toBe(2);
  });

  it('다른 모둠으로 옮기면 원래 모둠 접속자에게 상자가 나뉘고, 새 모둠에서는 상자가 없다', () => {
    const { session, students } = playing();
    const [a, b, c] = students.map((s) => s.memberId);
    const before = trays(session, 1)[a].length;
    const { events } = session.assign(a, 2);
    expect(events.filter((e) => e.to === 'group' && e.group === 1).map((e) => e.type)).toEqual(['tray', 'leave']);
    expect(before).toBe(12);
    expect(trays(session, 1)[b]).toHaveLength(24); // b had 12 and gets a's 12
    expect(trays(session, 2)[a]).toEqual([]);
    expect(trays(session, 2)[c]).toHaveLength(24);
    expect(trays(session, 1)[a]).toBeUndefined();
  });

  it('빈 모둠(시작 때 학생 0명)에 학생을 넣으면 그때 판을 만들고 그 학생이 조각을 모두 받는다', () => {
    const { session, students } = playing();
    expect(trays(session, 3)).toBeNull();
    session.assign(students[0].memberId, 3);
    const tray = trays(session, 3)[students[0].memberId];
    expect(Object.keys(trays(session, 3))).toEqual([students[0].memberId]);
    expect([...tray].sort((x, y) => x - y)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(session.overview().groups[2].empty).toBe(false);
  });

  it('퍼즐 동작은 자기 모둠 판으로 가고, 이벤트에는 모둠 번호가 붙는다', () => {
    const { session, students } = playing();
    const a = students[0].memberId;
    const piece = trays(session, 1)[a][0];
    const { result, events } = session.puzzle(a, 'takeFromTray', piece, 0, 0);
    expect(result.ok).toBe(true);
    expect(events).toMatchObject([{ to: 'group', group: 1, type: 'take', by: a, piece }]);
    const friends = trays(session, 1)[students[1].memberId][0];
    expect(session.puzzle(a, 'takeFromTray', friends, 0, 0).result).toEqual({ ok: false, reason: 'not-in-tray' });
    expect(session.puzzle(a, 'removeMember', a).result).toEqual({ ok: false, reason: 'bad-action' });
  });

  it('모둠이 없거나 대기 중이면 퍼즐 동작을 거부한다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    const [a] = joinMany(registry, session, ['가']);
    expect(session.puzzle(a.memberId, 'grab', 1).result).toEqual({ ok: false, reason: 'not-playing' });
    session.assign(a.memberId, 1);
    session.start();
    const late = registry.join(session.code, { name: '나' }).result;
    expect(session.puzzle(late.memberId, 'grab', 1).result).toEqual({ ok: false, reason: 'no-group' });
    expect(session.puzzle('nobody', 'grab', 1).result).toEqual({ ok: false, reason: 'not-member' });
  });

  it('끊김·복귀는 교사 명단과 모둠 판에 함께 전해지고, tick 이 1분 규칙을 돌린다', () => {
    const { registry, session, students, now } = playing();
    const [a, b] = students.map((s) => s.memberId);
    const off = session.memberOffline(a);
    expect(off).toEqual([
      { to: 'teacher', type: 'presence', memberId: a, online: false },
      { to: 'group', group: 1, type: 'member', memberId: a, online: false },
    ]);
    now.advance(60_000);
    const ticked = registry.tick();
    expect(ticked).toMatchObject([{ sessionId: session.id, to: 'group', group: 1, type: 'tray' }]);
    expect(trays(session, 1)[b]).toHaveLength(24);
  });

  it('교사 한눈에 보기 요약: 모둠별 덩어리·진행률·완성·학생 접속', () => {
    const { session, students } = playing();
    const a = students[0].memberId;
    const piece = trays(session, 1)[a][0];
    session.puzzle(a, 'takeFromTray', piece, 10, 20);
    const overview = session.overview();
    expect(overview).toMatchObject({ status: 'playing', startedAt: T0 });
    expect(overview.groups[0]).toMatchObject({
      number: 1,
      empty: false,
      completedAt: null,
      progress: { placed: 0, total: 24, complete: false },
      clusters: [{ x: 10, y: 20, locked: false, heldBy: null, pieces: [piece] }],
    });
    expect(overview.members.map((m) => [m.name, m.group, m.online])).toEqual([
      ['가', 1, true],
      ['나', 1, true],
      ['다', 2, true],
    ]);
  });
});

describe('끝내기 (D14)', () => {
  it('끝내면 모든 토큰이 무효가 되고 종료 이벤트를 보내며, 코드로도 들어올 수 없다', () => {
    const { registry, now } = makeRegistry();
    const session = openClass(registry);
    const [a] = joinMany(registry, session, ['가']);
    session.assign(a.memberId, 1);
    session.start();
    now.advance(5000);
    const { result, events } = registry.end(session.id);
    expect(result).toEqual({ ok: true, endedAt: T0 + 5000 });
    expect(events).toEqual([{ to: 'session', type: 'end' }]);
    expect(registry.byToken(a.token)).toBeNull();
    expect(registry.session(session.id)).toBeNull();
    expect(registry.join(session.code, { name: '가', token: a.token }).result).toEqual({ ok: false, error: 'invalid_code' });
    expect(session.toRecord()).toMatchObject({ status: 'ended', endedAt: T0 + 5000, members: [] });
    expect(session.puzzle(a.memberId, 'grab', 1).result.reason).toBe('not-playing');
    expect(session.assign(a.memberId, 2).result).toEqual({ ok: false, error: 'session_ended' });
    expect(registry.end(session.id).result).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('학생 이름은 저장용 기록에 없다 (D14)', () => {
  it('toRecord() 결과 어디에도 이름 문자열이 없다', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    const names = ['홍길동이름', 'ZebraName', '김민준표시'];
    const students = joinMany(registry, session, names);
    session.assign(students[0].memberId, 1);
    session.assign(students[1].memberId, 2);
    session.start();
    session.assign(students[2].memberId, 1);
    const text = JSON.stringify(session.toRecord());
    for (const name of names) expect(text).not.toContain(name);
    expect(session.roster().map((m) => m.name)).toEqual(names);
  });
});

describe('T19 보강', () => {
  it('수업당 학생 수 상한을 넘으면 class_full (같은 기기 재입장은 된다)', () => {
    const { registry } = makeRegistry({ maxMembers: 2 });
    const session = openClass(registry);
    const [a] = joinMany(registry, session, ['가', '나']);
    expect(registry.join(session.code, { name: '다' }).result).toEqual({ ok: false, error: 'class_full' });
    expect(registry.join(session.code, { name: '가', token: a.token }).result.ok).toBe(true);
  });

  it('수업 객체에는 end 가 없다 (registry.end 만 토큰까지 정리한다)', () => {
    const { registry } = makeRegistry();
    const session = openClass(registry);
    expect(session.end).toBeUndefined();
    expect(Object.keys(session)).not.toContain('end');
  });
});

describe('교사당 열린 수업 상한 (T20)', () => {
  it('한 교사의 열린 수업이 상한이면 too_many_sessions, 다른 교사는 열 수 있다', () => {
    const { registry } = makeRegistry({ maxOpenPerTeacher: 2 });
    const first = openClass(registry);
    openClass(registry);
    const third = registry.createSession('teacher-1', { pieceCount: 24, groupCount: 3, picture: BUILTIN });
    expect(third.result).toEqual({ ok: false, error: 'too_many_sessions' });
    expect(registry.createSession('teacher-2', { pieceCount: 24, groupCount: 3, picture: BUILTIN }).result.ok).toBe(true);
    registry.end(first.id);
    expect(registry.createSession('teacher-1', { pieceCount: 24, groupCount: 3, picture: BUILTIN }).result.ok).toBe(true);
  });
});
