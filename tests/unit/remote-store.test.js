import { describe, expect, it, vi } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { frameOrigin } from '../../public/js/puzzle/snap.js';
import { isPuzzleStore } from '../../public/js/store/puzzle-store.js';
import { StoreError, clustersFromBoard, createRemoteStore } from '../../public/js/store/remote-store.js';

// 4 x 3 picture: pw = ph = 100. me = 'a', friend = 'b'. Times are server ms.
const layout = layoutFor(4, 3, 4 / 3);
const ME = 'a';
const SERVER_NOW = 1_000_000;

// A cluster as the rt server sends it in a student 'state' (server/src/views.js).
const cluster = (id, x, y, pieces, extra = {}) => ({
  id,
  x,
  y,
  z: extra.z ?? id,
  locked: extra.locked ?? false,
  pieces,
  heldBy: extra.heldBy ?? null,
  heldAt: extra.heldAt ?? null,
});

// My tray: pieces 0, 1, 2. Board: cluster 20 = piece 5 (1,1).
function startBoard() {
  return { clusters: [cluster(20, 300, 200, [[1, 1]])], tray: [0, 1, 2], progress: { placed: 0, total: 12 }, completedAt: null };
}

// Fake class socket: answers are queued per message.
function fakeApi() {
  const api = {
    answers: { take: [], grab: [], drop: [], release: [] },
    calls: [],
    fail: null,
    async take(...args) {
      api.calls.push(['take', ...args]);
      if (api.fail) throw api.fail;
      return api.answers.take.shift();
    },
    async grab(...args) {
      api.calls.push(['grab', ...args]);
      if (api.fail) throw api.fail;
      return api.answers.grab.shift();
    },
    async drop(...args) {
      api.calls.push(['drop', ...args]);
      if (api.fail) throw api.fail;
      return api.answers.drop.shift();
    },
    async release(...args) {
      api.calls.push(['release', ...args]);
      return api.answers.release.shift() ?? { ok: true };
    },
  };
  return api;
}

const timers = () => ({ setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });

function makeStore(options = {}) {
  const api = fakeApi();
  const onMismatch = vi.fn();
  const onNotPlaying = vi.fn();
  let clock = 5_000; // local ms: the server is 995 000 ms ahead
  const store = createRemoteStore({
    api,
    me: ME,
    layout,
    seed: 7,
    picture: { src: '/p.png', width: 400, height: 300 },
    groupName: '1모둠',
    members: [
      { uid: 'a', name: '민준', color: 0, online: true },
      { uid: 'b', name: '서연', color: 1, online: true },
    ],
    startedAt: SERVER_NOW - 60_000,
    board: options.board ?? startBoard(),
    serverNow: SERVER_NOW,
    onMismatch,
    onNotPlaying,
    now: () => clock,
    timers: options.timers ?? timers(),
  });
  return { store, api, onMismatch, onNotPlaying, tick: (ms) => (clock += ms) };
}

const clusterOf = (store, id) => store.getState().clusters.find((c) => c.id === id);

describe('clustersFromBoard', () => {
  it('keeps clusters with pieces and moves hold times to this device clock', () => {
    const board = { clusters: [cluster(3, 1, 2, [[0, 0]], { heldBy: 'b', heldAt: 900 }), cluster(4, 0, 0, [])] };
    const map = clustersFromBoard(board, (ms) => ms - 100);
    expect([...map.keys()]).toEqual([3]);
    expect(map.get(3)).toMatchObject({ heldBy: 'b', heldAt: 800, pieces: [[0, 0]] });
  });
});

describe('createRemoteStore', () => {
  it('implements the PuzzleStore contract from the state board', () => {
    const { store } = makeStore();
    expect(isPuzzleStore(store)).toBe(true);
    const state = store.getState();
    expect(state.me).toBe(ME);
    expect([...state.tray].sort()).toEqual([0, 1, 2]);
    expect(state.clusters.map((c) => c.id)).toEqual([20]);
    expect(state.progress).toEqual({ placed: 0, total: 12, complete: false });
    expect(state.startedAt).toBe(SERVER_NOW - 60_000);
  });

  it('orders the tray by the seed, not by the picture position', () => {
    const board = { ...startBoard(), tray: [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11] };
    const a = makeStore({ board }).store.getState().tray;
    const b = makeStore({ board: { ...board, tray: [...board.tray].reverse() } }).store.getState().tray;
    expect(a).toEqual(b);
    expect(a).not.toEqual([...a].sort((x, y) => x - y));
  });

  it('takes a tray piece: held by me at the clamped spot until drop() settles the server answer', async () => {
    const { store, api } = makeStore();
    api.answers.take.push({ ok: true, piece: 0, clusterId: 31, id: 31, x: -10, y: 40, z: 9, locked: false, absorbed: [], progress: { placed: 0, total: 12, complete: false }, completedAt: null });
    const taken = await store.takeFromTray(0, -500, 40);
    expect(taken).toEqual({ ok: true, clusterId: 31 });
    expect(api.calls[0]).toEqual(['take', 0, -500, 40]);
    expect(store.getState().tray).not.toContain(0);
    const held = clusterOf(store, 31);
    expect(held.heldBy).toBe(ME);
    expect(held.x).toBeGreaterThan(-500); // clamped like local-store
    const dropped = await store.drop(31, -500, 40);
    expect(dropped).toMatchObject({ ok: true, id: 31, x: -10, y: 40, absorbed: [] });
    expect(clusterOf(store, 31)).toMatchObject({ x: -10, y: 40, heldBy: null, z: 9 });
    expect(api.calls.filter(([name]) => name === 'drop')).toEqual([]); // take already dropped it
  });

  it('a piece leaves the tray at once and comes back if the take fails', async () => {
    const { store, api, onMismatch } = makeStore();
    api.fail = new Error('timeout');
    const before = store.getState().tray.length;
    const pending = store.takeFromTray(1, 0, 0);
    expect(store.getState().tray).toHaveLength(before - 1);
    await expect(pending).rejects.toBeInstanceOf(StoreError);
    expect(store.getState().tray).toHaveLength(before);
    expect(onMismatch).toHaveBeenCalled(); // no answer: a fresh state tells what happened
  });

  it('refusals keep the tray and are passed on', async () => {
    const { store, api, onNotPlaying } = makeStore();
    api.answers.take.push({ ok: false, reason: 'bad-position' });
    expect(await store.takeFromTray(2, 0, 0)).toEqual({ ok: false, reason: 'bad-position' });
    expect(store.getState().tray).toContain(2);
    expect(await store.takeFromTray(9, 0, 0)).toEqual({ ok: false, reason: 'not-in-tray' });
    api.answers.grab.push({ ok: false, reason: 'not-playing' });
    expect(await store.grab(20)).toEqual({ ok: false, reason: 'not-playing' });
    expect(onNotPlaying).toHaveBeenCalledTimes(1);
  });

  it('grab: a refused grab shows who holds it; a granted one sets the clock from the server', async () => {
    const { store, api, tick } = makeStore();
    api.answers.grab.push({ ok: false, reason: 'held', heldBy: 'b' });
    expect(await store.grab(20)).toEqual({ ok: false, reason: 'held', heldBy: 'b' });
    expect(clusterOf(store, 20).heldBy).toBe('b');
    tick(1000);
    api.answers.grab.push({ ok: true, z: 30, heldAt: SERVER_NOW + 5000 });
    expect(await store.grab(20)).toEqual({ ok: true });
    expect(clusterOf(store, 20)).toMatchObject({ heldBy: ME, z: 30, heldAt: 6000 });
    expect(store.clockOffset).toBe(SERVER_NOW + 5000 - 6000);
  });

  it('dropping after the server let go (not-held) grabs again and drops once more', async () => {
    const { store, api } = makeStore();
    api.answers.drop.push({ ok: false, reason: 'not-held' });
    api.answers.grab.push({ ok: true, z: 31, heldAt: SERVER_NOW });
    api.answers.drop.push({ ok: true, clusterId: 20, id: 20, x: 333, y: 222, z: 31, locked: false, absorbed: [], progress: { placed: 0, total: 12, complete: false }, completedAt: null });
    expect(await store.drop(20, 333, 222)).toMatchObject({ ok: true, id: 20, x: 333, y: 222 });
    expect(api.calls.map(([name]) => name)).toEqual(['drop', 'grab', 'drop']);
    expect(clusterOf(store, 20)).toMatchObject({ x: 333, y: 222, heldBy: null });
  });

  it('… and when a friend holds it by then, the drop is refused with held (the screen slides it back)', async () => {
    const { store, api } = makeStore();
    api.answers.drop.push({ ok: false, reason: 'not-held' });
    api.answers.grab.push({ ok: false, reason: 'held', heldBy: 'b' });
    expect(await store.drop(20, 333, 222)).toEqual({ ok: false, reason: 'held', heldBy: 'b' });
    expect(clusterOf(store, 20)).toMatchObject({ x: 300, y: 200, heldBy: 'b' });
  });

  it("applies friends' events: grab, take, drop with a merge, tray, release, complete", () => {
    const { store, onMismatch } = makeStore();
    const changes = [];
    store.subscribe((_, change) => changes.push(change.type));
    store.applyEvents([
      { type: 'grab', by: 'b', clusterId: 20, z: 40, heldAt: SERVER_NOW + 1000 },
      { type: 'member', memberId: 'b', online: true },
    ]);
    expect(clusterOf(store, 20)).toMatchObject({ heldBy: 'b', heldAt: 5000 + 1000, z: 40 });
    // b takes piece 4 (0,1) and it joins cluster 20 (piece 5 (1,1)): survivor 20.
    store.applyEvents([
      { type: 'take', by: 'b', piece: 4, clusterId: 32, id: 20, x: 300, y: 200, z: 41, locked: false, absorbed: [32], progress: { placed: 0, total: 12 } },
    ]);
    expect(clusterOf(store, 20).pieces).toEqual([[1, 1], [0, 1]]);
    expect(clusterOf(store, 32)).toBeUndefined();
    store.applyEvents([{ type: 'release', by: 'b', clusterId: 20, reason: 'idle' }]);
    expect(clusterOf(store, 20).heldBy).toBeNull();
    store.applyEvents([{ type: 'tray', pieces: [{ piece: 7, from: 'c', to: ME }, { piece: 0, from: ME, to: 'b' }] }]);
    expect(store.getState().tray).toContain(7);
    expect(store.getState().tray).not.toContain(0);
    const { ox, oy } = frameOrigin(layout);
    store.applyEvents([
      { type: 'drop', by: 'b', clusterId: 20, id: 20, x: ox, y: oy, z: 42, locked: true, absorbed: [], progress: { placed: 2, total: 12 } },
      { type: 'complete', completedAt: SERVER_NOW + 9000 },
    ]);
    expect(clusterOf(store, 20)).toMatchObject({ locked: true, x: ox, y: oy });
    expect(store.getState().progress).toEqual({ placed: 2, total: 12, complete: false });
    expect(store.getState().completedAt).toBe(SERVER_NOW + 9000);
    expect(changes).toEqual(['grab', 'take', 'release', 'tray', 'drop', 'complete']);
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('a cluster of several pieces absorbed into another keeps every piece', () => {
    const board = { ...startBoard(), clusters: [cluster(20, 300, 200, [[1, 1]]), cluster(21, 0, 0, [[2, 1], [3, 1], [3, 2]])] };
    const { store, onMismatch } = makeStore({ board });
    store.applyEvents([{ type: 'drop', by: 'b', clusterId: 21, id: 20, x: 300, y: 200, z: 5, locked: false, absorbed: [21], progress: { placed: 0, total: 12 } }]);
    expect(store.getState().clusters).toHaveLength(1);
    expect(clusterOf(store, 20).pieces).toEqual([[1, 1], [2, 1], [3, 1], [3, 2]]);
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('an old release does not end a newer hold, and my own take/grab/drop echoes are skipped', async () => {
    const { store, api } = makeStore();
    api.answers.grab.push({ ok: true, z: 50, heldAt: SERVER_NOW });
    await store.grab(20);
    // The friend's hold ended (idle) in the same step the server gave the cluster to me.
    store.applyEvents([
      { type: 'release', by: 'b', clusterId: 20, reason: 'idle' },
      { type: 'grab', by: ME, clusterId: 20, z: 50, heldAt: SERVER_NOW },
      { type: 'drop', by: ME, clusterId: 20, id: 20, x: 0, y: 0, absorbed: [] },
    ]);
    expect(clusterOf(store, 20)).toMatchObject({ heldBy: ME, x: 300, y: 200 });
    store.applyEvents([{ type: 'release', by: ME, clusterId: 20, reason: 'limit' }]);
    expect(clusterOf(store, 20).heldBy).toBeNull();
  });

  it('an event that does not fit the board asks for a fresh state, which replaces everything', () => {
    const { store, onMismatch } = makeStore();
    store.applyEvents([{ type: 'drop', by: 'b', clusterId: 77, id: 77, x: 0, y: 0, absorbed: [78] }]);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    store.applyBoard({ clusters: [cluster(77, 10, 20, [[0, 0], [1, 0]], { heldBy: 'b', heldAt: SERVER_NOW + 100 })], tray: [2], completedAt: null }, SERVER_NOW + 200);
    expect(store.getState().clusters.map((c) => c.id)).toEqual([77]);
    expect(store.getState().tray).toEqual([2]);
    expect(clusterOf(store, 77).heldAt).toBe(5000 - 100); // offset from the new state's time
  });

  it('a fresh state while a taken piece waits for drop(): the state wins', async () => {
    const t = timers();
    const { store, api } = makeStore({ timers: t });
    api.answers.take.push({ ok: true, piece: 0, clusterId: 31, id: 20, x: 300, y: 200, z: 9, locked: false, absorbed: [31], progress: { placed: 0, total: 12 }, completedAt: null });
    await store.takeFromTray(0, 280, 190);
    store.applyBoard({ clusters: [cluster(20, 300, 200, [[1, 1], [0, 0]])], tray: [1, 2], completedAt: null }, SERVER_NOW);
    expect(t.clearTimeout).toHaveBeenCalled();
    expect(await store.drop(31, 280, 190)).toMatchObject({ ok: true, id: 20 });
    expect(clusterOf(store, 20).pieces).toEqual([[1, 1], [0, 0]]);
    expect(api.calls.filter(([name]) => name === 'drop')).toEqual([]);
  });

  it('release() lets go of everything I hold (the page was hidden)', async () => {
    const { store, api } = makeStore({ board: { ...startBoard(), clusters: [cluster(20, 0, 0, [[1, 1]], { heldBy: ME, heldAt: SERVER_NOW })] } });
    expect(await store.release()).toEqual({ ok: true });
    expect(api.calls).toEqual([['release']]);
    expect(clusterOf(store, 20).heldBy).toBeNull();
  });

  it('members come from outside and dispose stops listeners and timers', async () => {
    const t = timers();
    const { store, api } = makeStore({ timers: t });
    const seen = [];
    store.subscribe((state) => seen.push(state.members.length));
    store.setMembers([{ uid: 'a', name: '민준', color: 0, online: true }]);
    store.setMembers([{ uid: 'a', name: '민준', color: 0, online: true }]); // same: no change
    expect(seen).toEqual([1]);
    api.answers.take.push({ ok: true, piece: 0, clusterId: 31, id: 31, x: 0, y: 0, absorbed: [], progress: { placed: 0, total: 12 } });
    await store.takeFromTray(0, 0, 0);
    const heard = seen.length;
    store.dispose();
    expect(t.clearTimeout).toHaveBeenCalled();
    store.applyEvents([{ type: 'grab', by: 'b', clusterId: 20 }]);
    store.applyBoard(startBoard(), SERVER_NOW);
    expect(seen).toHaveLength(heard);
  });
});
