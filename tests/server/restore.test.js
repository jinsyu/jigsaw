// T18: an open class saved with toRecord() comes back the same after a restart, saved
// boards are checked before they are used, and open classes close after 24 hours.
import { describe, expect, it } from 'vitest';
import { rng } from '../../public/js/puzzle/geometry.js';
import { OPEN_LIMIT_MS, createRegistry } from '../../server/src/engine/registry.js';

const T0 = Date.parse('2026-10-09T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function makeRegistry() {
  let t = T0;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  let n = 0;
  const next = rng(3);
  const registry = createRegistry({
    now,
    random: rng(4),
    randomInt: (min, max) => min + Math.floor(next() * (max - min)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    newToken: () => `token-${++n}`,
  });
  return { registry, now };
}

function playingClass(registry) {
  const { result } = registry.createSession('teacher-1', {
    pieceCount: 12,
    groupCount: 3,
    picture: { builtinKey: 'sea', aspect: 1999 / 1123 },
    hints: { underlay: true },
  });
  const session = registry.session(result.sessionId);
  const students = ['가', '나', '다'].map((name) => registry.join(session.code, { name }).result);
  session.assign(students[0].memberId, 1);
  session.assign(students[1].memberId, 1);
  session.assign(students[2].memberId, 2);
  for (const s of students) session.memberOnline(s.memberId);
  session.start();
  const tray = (id) => session.toRecord().groups[0].board.trays[id];
  const a = students[0].memberId;
  const taken = session.puzzle(a, 'takeFromTray', tray(a)[0], 33.25, 41.5).result;
  session.puzzle(a, 'takeFromTray', tray(a)[0], 400, 10);
  session.puzzle(students[1].memberId, 'grab', taken.id); // held: not saved
  // Group 2 is left empty: its pieces stay unowned until someone joins it.
  session.assign(students[2].memberId, 3);
  return { session, students };
}

// What T18 saves is JSON (jsonb and columns), so restore from a JSON copy.
const saved = (session) => JSON.parse(JSON.stringify(session.toRecord()));

describe('저장한 수업 복구', () => {
  it('판·상자·주인 없는 조각·배정·도움 설정이 그대로 돌아온다 (잡기는 놓인 상태)', () => {
    const { registry } = makeRegistry();
    const { session } = playingClass(registry);
    const record = saved(session);
    const { registry: restarted } = makeRegistry();
    const back = restarted.restore(record);
    expect(back.toRecord()).toEqual(record);
    expect(record.groups[1].board.unowned.length).toBeGreaterThan(0);
    expect(back.overview().groups[0].clusters.every((c) => c.heldBy === null)).toBe(true);
    expect(record.aspect).toBe(1999 / 1123);
  });

  it('학생은 끊긴 상태로 시작하고 이름은 비어 있다가, 같은 토큰으로 다시 들어오면 채워진다', () => {
    const { registry } = makeRegistry();
    const { session, students } = playingClass(registry);
    const { registry: restarted } = makeRegistry();
    const back = restarted.restore(saved(session));
    expect(back.roster().map((m) => [m.name, m.online])).toEqual([
      ['', false],
      ['', false],
      ['', false],
    ]);
    expect(restarted.byToken(students[0].token)).toMatchObject({ memberId: students[0].memberId });
    const again = restarted.join(back.code, { name: '가', token: students[0].token }).result;
    expect(again).toMatchObject({ ok: true, memberId: students[0].memberId, group: 1 });
    expect(back.roster()[0].name).toBe('가');
  });

  it('복구 뒤 아무도 돌아오지 않은 학생에게도 1분 규칙이 그대로 적용된다', () => {
    const { registry } = makeRegistry();
    const { session, students } = playingClass(registry);
    const { registry: restarted, now } = makeRegistry();
    const back = restarted.restore(saved(session));
    back.memberOnline(students[1].memberId);
    now.advance(60_000);
    const events = restarted.tick();
    expect(events.map((e) => [e.group, e.type])).toEqual([[1, 'tray']]);
    expect(back.toRecord().groups[0].board.trays[students[0].memberId]).toEqual([]);
  });

  it('대기 중인 수업도 복구되고, 같은 코드의 새 수업은 그 코드를 쓰지 못한다', () => {
    const { registry } = makeRegistry();
    const { result } = registry.createSession('teacher-1', { pieceCount: 24, groupCount: 2, picture: { imageId: 'img', width: 3, height: 4 } });
    const session = registry.session(result.sessionId);
    registry.join(session.code, { name: '가' });
    const { registry: restarted } = makeRegistry();
    restarted.restore(saved(session));
    expect(restarted.session(session.id).status).toBe('waiting');
    expect(() => restarted.restore(saved(session))).toThrow(RangeError);
  });
});

describe('복구 입력 검증', () => {
  function brokenCopy(mutate) {
    const { registry } = makeRegistry();
    const { session } = playingClass(registry);
    const record = saved(session);
    mutate(record.groups[0].board, record);
    return () => makeRegistry().registry.restore(record);
  }

  it.each([
    ['정수가 아닌 덩어리 id', (b) => (b.clusters[0].id = 1.5)],
    ['0 이하 덩어리 id', (b) => (b.clusters[0].id = 0)],
    ['겹치는 덩어리 id', (b) => b.clusters.push({ ...b.clusters[0], pieces: [[3, 2]] })],
    ['빠진 조각', (b) => Object.values(b.trays)[0].pop()],
    ['두 곳에 있는 조각', (b) => Object.values(b.trays)[0].push(b.clusters[0].pieces[0][1] * 4 + b.clusters[0].pieces[0][0])],
    ['격자 밖 칸', (b) => (b.clusters[0].pieces = [[9, 9]])],
    ['모둠에 없는 학생의 상자', (b) => (b.trays.stranger = [])],
    ['위치가 숫자가 아님', (b) => (b.clusters[0].x = null)],
    ['끝난 수업', (_b, r) => (r.status = 'ended')],
  ])('%s 이면 복구하지 않는다', (_name, mutate) => {
    expect(brokenCopy(mutate)).toThrow(RangeError);
  });
});

describe('24시간 자동 종료', () => {
  it('시작한 수업은 시작 시각, 시작 전 수업은 만든 시각부터 24시간이 지나면 registry 에서 닫는다', () => {
    const { registry, now } = makeRegistry();
    const make = () => registry.session(registry.createSession('t', { pieceCount: 12, groupCount: 1, picture: { builtinKey: 'a', aspect: 1 } }).result.sessionId);
    const waiting = make();
    const started = make();
    const student = registry.join(started.code, { name: '가' }).result;
    started.assign(student.memberId, 1);
    now.advance(2 * HOUR);
    started.start();
    now.advance(OPEN_LIMIT_MS - 2 * HOUR - 1);
    expect(registry.expireStale()).toEqual([]);
    now.advance(1);
    const closed = registry.expireStale();
    expect(closed.map((c) => c.sessionId)).toEqual([waiting.id]);
    expect(closed[0]).toMatchObject({ result: { ok: true }, events: [{ to: 'session', type: 'end' }] });
    expect(registry.session(waiting.id)).toBeNull();
    now.advance(2 * HOUR);
    expect(registry.expireStale().map((c) => c.sessionId)).toEqual([started.id]);
    expect(registry.byToken(student.token)).toBeNull();
    expect(registry.openCount).toBe(0);
  });
});
