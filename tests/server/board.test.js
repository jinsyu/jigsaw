// T15: the rt server's board engine for one group (pure logic, fake clock).
import { describe, expect, it } from 'vitest';
import { layoutFor, rng } from '../../public/js/puzzle/geometry.js';
import { HOLD_MS, frameOrigin } from '../../public/js/puzzle/snap.js';
import { GONE_MS, HOLD_LIMIT_MS, createBoard } from '../../server/src/engine/board.js';
import { NOW, byOf, expectCaseResult, onlineOf, table } from '../fixtures/snap-case.js';

const ASPECT = 4 / 3;

function fakeClock(start = NOW) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

// 12 pieces (4 x 3), members a..e unless given, dealt with a fixed random.
function makeBoard({ members = ['a', 'b', 'c'], pieceGrid = [4, 3], ...rest } = {}) {
  const now = rest.now ?? fakeClock();
  const board = createBoard({
    cols: pieceGrid[0],
    rows: pieceGrid[1],
    aspect: ASPECT,
    members: members.map((id) => ({ id, online: true })),
    random: rng(11),
    ...rest,
    now,
  });
  return { board, now };
}

const types = (events) => events.map((e) => e.type);
const trayOf = (board, id) => board.getState().trays[id];
const clusterOf = (board, id) => board.getState().clusters.find((c) => c.id === id);

// Takes the first tray piece of `member` to a far corner (no neighbours) and returns its cluster id.
function placeOne(board, member, x = 0, y = 0) {
  const piece = trayOf(board, member)[0];
  const { result } = board.takeFromTray(member, piece, x, y);
  expect(result.ok).toBe(true);
  return result.id;
}

describe('조각 나누기 (D5)', () => {
  it('24조각·5명이면 5·5·5·5·4 로 나뉘고, 모든 조각이 한 번씩 상자에 있다', () => {
    const { board } = makeBoard({ members: ['a', 'b', 'c', 'd', 'e'], pieceGrid: [6, 4] });
    const { trays, clusters } = board.getState();
    expect(Object.values(trays).map((t) => t.length).sort((x, y) => y - x)).toEqual([5, 5, 5, 5, 4]);
    expect(Object.values(trays).flat().sort((x, y) => x - y)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(clusters).toEqual([]);
  });

  it('학생이 없으면 판을 만들지 않는다 (빈 모둠은 T16 에서 따로 처리)', () => {
    expect(() => makeBoard({ members: [] })).toThrow(RangeError);
  });

  it('남의 상자 조각은 꺼낼 수 없다', () => {
    const { board } = makeBoard();
    const piece = trayOf(board, 'b')[0];
    const { result, events } = board.takeFromTray('a', piece, 0, 0);
    expect(result).toEqual({ ok: false, reason: 'not-in-tray' });
    expect(events).toEqual([]);
    expect(trayOf(board, 'b')).toContain(piece);
  });

  it('내 상자 조각을 꺼내면 놓기와 같이 판정되고 놓인 상태가 된다', () => {
    const { board } = makeBoard();
    const piece = trayOf(board, 'a')[0];
    const { result, events } = board.takeFromTray('a', piece, 5, 5);
    expect(result).toMatchObject({ ok: true, piece, x: 5, y: 5, locked: false, absorbed: [] });
    expect(types(events)).toEqual(['take']);
    expect(events[0]).toMatchObject({ by: 'a', piece, id: result.id, x: 5, y: 5 });
    expect(trayOf(board, 'a')).not.toContain(piece);
    expect(clusterOf(board, result.id)).toMatchObject({ heldBy: null, pieces: [[piece % 4, Math.floor(piece / 4)]] });
  });

  it('잘못된 위치·모르는 학생은 거부한다', () => {
    const { board } = makeBoard();
    const piece = trayOf(board, 'a')[0];
    expect(board.takeFromTray('a', piece, Number.NaN, 0).result).toEqual({ ok: false, reason: 'bad-position' });
    expect(board.takeFromTray('zed', piece, 0, 0).result).toEqual({ ok: false, reason: 'not-member' });
  });
});

describe('잡기 (D6)', () => {
  it('동시에 잡으면 먼저 도착한 한 명만 성공하고, 늦은 쪽은 누가 잡았는지 듣는다', () => {
    const { board } = makeBoard();
    const id = placeOne(board, 'a');
    const first = board.grab('b', id);
    const second = board.grab('c', id);
    expect(first.result).toMatchObject({ ok: true });
    expect(types(first.events)).toEqual(['grab']);
    expect(first.events[0]).toMatchObject({ by: 'b', clusterId: id });
    expect(second.result).toEqual({ ok: false, reason: 'held', heldBy: 'b' });
    expect(second.events).toEqual([]);
  });

  it('잡은 덩어리를 다른 학생은 놓을 수 없다', () => {
    const { board } = makeBoard();
    const id = placeOne(board, 'a');
    board.grab('b', id);
    expect(board.drop('c', id, 10, 10).result).toEqual({ ok: false, reason: 'not-held' });
  });

  it('고정된 덩어리는 잡을 수 없다', () => {
    const { board } = makeBoard({
      trays: {},
      clusters: [{ id: 1, x: 0, y: 0, locked: true, pieces: [[0, 0]] }],
    });
    expect(board.grab('a', 1).result).toEqual({ ok: false, reason: 'locked' });
  });

  it('없는 덩어리는 not-found', () => {
    const { board } = makeBoard();
    expect(board.grab('a', 999).result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('놓아주기(release)는 잡은 학생만, 덩어리는 그 자리에 남는다', () => {
    const { board } = makeBoard();
    const id = placeOne(board, 'a', 30, 40);
    board.grab('a', id);
    expect(board.release('b', id).result).toEqual({ ok: false, reason: 'not-held' });
    const { result, events } = board.release('a', id);
    expect(result).toEqual({ ok: true });
    expect(events).toEqual([{ type: 'release', clusterId: id, by: 'a', reason: 'request' }]);
    expect(clusterOf(board, id)).toMatchObject({ x: 30, y: 40, heldBy: null });
  });
});

describe('잡기 시간 (D8, 가짜 시계)', () => {
  it('잡은 채 10초 가만히 있으면 놓이고 다른 학생이 잡는다 (10초 직전은 아직 잡힘)', () => {
    const { board, now } = makeBoard();
    const id = placeOne(board, 'a');
    board.grab('a', id);
    now.advance(HOLD_MS - 1);
    expect(board.tick()).toEqual([]);
    expect(board.grab('b', id).result).toMatchObject({ ok: false, reason: 'held' });
    now.advance(1);
    expect(board.tick()).toEqual([{ type: 'release', clusterId: id, by: 'a', reason: 'idle' }]);
    expect(board.grab('b', id).result.ok).toBe(true);
  });

  it('놓인 뒤의 놓기는 거부된다 (덩어리는 그대로)', () => {
    const { board, now } = makeBoard();
    const id = placeOne(board, 'a', 0, 0);
    board.grab('a', id);
    now.advance(HOLD_MS);
    const { result, events } = board.drop('a', id, 200, 200);
    expect(result).toEqual({ ok: false, reason: 'not-held' });
    expect(events).toEqual([{ type: 'release', clusterId: id, by: 'a', reason: 'idle' }]);
    expect(clusterOf(board, id)).toMatchObject({ x: 0, y: 0 });
  });

  it('다시 잡기로 연장할 수 있지만, 처음 잡은 뒤 60초가 되면 놓인다', () => {
    const { board, now } = makeBoard();
    const id = placeOne(board, 'a');
    const firstGrab = now();
    board.grab('a', id);
    while (now() + HOLD_MS - 1 < firstGrab + HOLD_LIMIT_MS) {
      now.advance(HOLD_MS - 1);
      const extended = board.grab('a', id);
      expect(extended.result.ok).toBe(true);
      expect(extended.events).toMatchObject([{ type: 'grab', by: 'a', clusterId: id, heldAt: now() }]);
      expect(board.grab('b', id).result.reason).toBe('held');
    }
    now.advance(firstGrab + HOLD_LIMIT_MS - 1 - now());
    expect(board.tick()).toEqual([]);
    now.advance(1);
    expect(board.tick()).toEqual([{ type: 'release', clusterId: id, by: 'a', reason: 'limit' }]);
    expect(board.grab('b', id).result.ok).toBe(true);
  });

  it('끊기면 잡은 덩어리가 바로 놓인다', () => {
    const { board } = makeBoard();
    const id = placeOne(board, 'a');
    board.grab('a', id);
    const events = board.memberOffline('a');
    expect(events).toEqual([
      { type: 'release', clusterId: id, by: 'a', reason: 'offline' },
      { type: 'member', memberId: 'a', online: false },
    ]);
    expect(board.grab('b', id).result.ok).toBe(true);
  });

  it('끊긴 학생은 동작할 수 없다', () => {
    const { board } = makeBoard();
    const piece = trayOf(board, 'a')[0];
    board.memberOffline('a');
    expect(board.takeFromTray('a', piece, 0, 0).result).toEqual({ ok: false, reason: 'offline' });
  });
});

describe('끊김 1분 뒤 상자 나누기 (D9, 가짜 시계)', () => {
  it('1분이 지나면 남은 상자 조각을 접속 중인 모둠원(늦게 온 학생 포함)에게 고르게 한 번만 나눈다', () => {
    const { board, now } = makeBoard({ members: ['a', 'b', 'c'] });
    board.addMember('late');
    const gone = [...trayOf(board, 'a')];
    expect(gone).toHaveLength(4);
    board.memberOffline('a');
    now.advance(GONE_MS - 1);
    expect(board.tick()).toEqual([]);
    now.advance(1);
    const events = board.tick();
    expect(types(events)).toEqual(['tray']);
    const dealt = events[0].pieces;
    expect(dealt.map((p) => p.piece).sort((x, y) => x - y)).toEqual([...gone].sort((x, y) => x - y));
    expect(dealt.every((p) => p.from === 'a')).toBe(true);
    expect(trayOf(board, 'a')).toEqual([]);
    // b and c have 4 each and late has none: fewest first, then round-robin (2, 1, 1).
    expect(['late', 'b', 'c'].map((id) => trayOf(board, id).length)).toEqual([2, 5, 5]);
    now.advance(GONE_MS);
    expect(board.tick()).toEqual([]);
  });

  it('1분 안에 같은 학생이 돌아오면 상자는 그대로다', () => {
    const { board, now } = makeBoard();
    const before = [...trayOf(board, 'a')];
    board.memberOffline('a');
    now.advance(GONE_MS - 1);
    expect(board.memberOnline('a')).toEqual([{ type: 'member', memberId: 'a', online: true }]);
    now.advance(GONE_MS);
    expect(board.tick()).toEqual([]);
    expect(trayOf(board, 'a')).toEqual(before);
  });

  it('접속 중인 모둠원이 없으면 나누지 않는다 (누가 돌아오면 그때 나눈다)', () => {
    const { board, now } = makeBoard({ members: ['a', 'b'] });
    const aTray = [...trayOf(board, 'a')];
    board.memberOffline('a');
    board.memberOffline('b');
    now.advance(GONE_MS * 3);
    expect(board.tick()).toEqual([]);
    expect(trayOf(board, 'a')).toEqual(aTray);
    board.memberOnline('b');
    const events = board.tick();
    expect(types(events)).toEqual(['tray']);
    expect(trayOf(board, 'a')).toEqual([]);
    expect(trayOf(board, 'b')).toHaveLength(12);
  });

  it('처음부터 끊긴 상태로 만든 학생(재시작 복구)도 1분 규칙을 따른다', () => {
    const now = fakeClock();
    const board = createBoard({
      cols: 4,
      rows: 3,
      aspect: ASPECT,
      members: [{ id: 'a', online: false }, { id: 'b', online: true }],
      trays: { a: [0, 1], b: [2] },
      random: rng(1),
      now,
    });
    now.advance(GONE_MS);
    expect(types(board.tick())).toEqual(['tray']);
    expect(trayOf(board, 'b').sort()).toEqual([0, 1, 2]);
  });
});

describe('맞춤·완성 (D7, D10)', () => {
  it('마지막 조각이 고정되면 완성 시각을 한 번 정하고 complete 이벤트를 보낸다', () => {
    const now = fakeClock();
    // Everything locked in the frame except piece 11 (col 3, row 2) in a's tray.
    const frame = frameOrigin(layoutFor(4, 3, ASPECT));
    const lockedCells = Array.from({ length: 11 }, (_, i) => [i % 4, Math.floor(i / 4)]);
    const board = createBoard({
      cols: 4,
      rows: 3,
      aspect: ASPECT,
      members: [{ id: 'a', online: true }],
      trays: { a: [11] },
      clusters: [{ id: 1, x: frame.x, y: frame.y, locked: true, pieces: lockedCells }],
      random: rng(1),
      now,
    });
    now.advance(5000);
    const { result, events } = board.takeFromTray('a', 11, frame.x + 3, frame.y - 2);
    expect(result).toMatchObject({ ok: true, id: 1, locked: true, absorbed: [2], progress: { placed: 12, total: 12, complete: true } });
    expect(types(events)).toEqual(['take', 'complete']);
    expect(events[1]).toEqual({ type: 'complete', completedAt: now() });
    expect(board.getState().completedAt).toBe(now());
    expect(board.getState().progress).toEqual({ placed: 12, total: 12, complete: true });
  });

  it('붙은 덩어리는 한 덩어리로 함께 움직인다', () => {
    const { board } = makeBoard({ trays: { a: [0, 1], b: [], c: [] } });
    const left = board.takeFromTray('a', 0, 10, 10).result.id;
    const merged = board.takeFromTray('a', 1, 12, 8).result;
    expect(merged).toMatchObject({ id: left, absorbed: [left + 1] });
    board.grab('b', left);
    const moved = board.drop('b', left, 300, 200).result;
    expect(moved).toMatchObject({ ok: true, id: left, x: 300, y: 200 });
    expect(board.getState().clusters).toHaveLength(1);
    expect(clusterOf(board, left).pieces).toEqual([[0, 0], [1, 0]]);
  });
});

// D7: every case of the shared table, played through the engine's drop path.
describe('snap-cases.json 전 사례를 엔진 drop 경로로 (D7)', () => {
  it.each(table.cases.map((c) => [c.name, c]))('%s', (_name, { input, expected }) => {
    const now = fakeClock(NOW);
    const me = byOf(input);
    const online = new Set(onlineOf(input));
    const ids = new Set([me, ...input.clusters.map((c) => c.heldBy).filter(Boolean)]);
    const board = createBoard({
      cols: input.grid.cols,
      rows: input.grid.rows,
      aspect: input.grid.aspect,
      members: [...ids].map((id) => ({ id, online: id === me || online.has(id) })),
      trays: {},
      clusters: input.clusters.map(({ heldMsAgo, ...c }) =>
        heldMsAgo === undefined ? c : { ...c, heldAt: NOW - heldMsAgo, heldSince: NOW - heldMsAgo },
      ),
      tolerance: input.tolerance,
      random: rng(1),
      now,
    });
    expect(board.grab(me, input.drop.id).result.ok).toBe(true);
    const { result } = board.drop(me, input.drop.id, input.drop.x, input.drop.y);
    expect(result.ok).toBe(true);
    const state = board.getState();
    expectCaseResult(
      {
        id: result.id,
        x: result.x,
        y: result.y,
        locked: result.locked,
        absorbed: result.absorbed,
        ...result.progress,
        clusters: [...state.clusters].sort((a, b) => a.id - b.id),
      },
      expected,
    );
  });
});

describe('모둠 이동: removeMember·addMember (T16)', () => {
  it('옮긴 학생의 잡기는 풀리고, 상자는 남은 접속자에게 고르게 나뉜다', () => {
    const { board } = makeBoard({ members: ['a', 'b', 'c'] });
    const id = placeOne(board, 'b');
    board.grab('a', id);
    board.memberOffline('c');
    const tray = [...trayOf(board, 'a')];
    const events = board.removeMember('a');
    expect(types(events)).toEqual(['release', 'tray', 'leave']);
    expect(events[0]).toEqual({ type: 'release', clusterId: id, by: 'a', reason: 'moved' });
    expect(events[1].pieces.map((p) => p.piece).sort((x, y) => x - y)).toEqual([...tray].sort((x, y) => x - y));
    expect(events[1].pieces.every((p) => p.from === 'a' && p.to === 'b')).toBe(true);
    expect(board.getState().members.map((m) => m.id)).toEqual(['b', 'c']);
    expect(board.grab('a', id).result).toEqual({ ok: false, reason: 'not-member' });
  });

  it('남은 학생이 모두 끊겼으면 남은 학생 모두에게 나눈다', () => {
    const { board } = makeBoard({ members: ['a', 'b', 'c'] });
    board.memberOffline('b');
    board.memberOffline('c');
    board.removeMember('a');
    expect(trayOf(board, 'b').length + trayOf(board, 'c').length).toBe(12);
    expect(Math.abs(trayOf(board, 'b').length - trayOf(board, 'c').length)).toBeLessThanOrEqual(1);
  });

  it('마지막 학생이 떠나면 상자는 주인 없이 남고, 다음에 들어온 학생이 모두 받는다', () => {
    const { board } = makeBoard({ members: ['a'] });
    placeOne(board, 'a');
    expect(types(board.removeMember('a'))).toEqual(['leave']);
    const events = board.addMember('z');
    expect(types(events)).toEqual(['member', 'tray']);
    expect(trayOf(board, 'z')).toHaveLength(11);
    expect(events[1].pieces.every((p) => p.from === null && p.to === 'z')).toBe(true);
  });
});

describe('한 학생은 한 덩어리만 잡는다 (T19 결정)', () => {
  it('다른 덩어리를 잡으면 먼저 잡은 덩어리는 놓인다', () => {
    const { board } = makeBoard();
    const first = placeOne(board, 'a', 0, 0);
    const second = placeOne(board, 'a', 500, 300);
    board.grab('a', first);
    const { result, events } = board.grab('a', second);
    expect(result.ok).toBe(true);
    expect(events).toMatchObject([
      { type: 'release', clusterId: first, by: 'a', reason: 'regrab' },
      { type: 'grab', clusterId: second, by: 'a' },
    ]);
    expect(board.grab('b', first).result.ok).toBe(true);
  });
});
