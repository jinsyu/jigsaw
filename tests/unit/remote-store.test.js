import { describe, expect, it, vi } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { frameOrigin } from '../../public/js/puzzle/snap.js';
import { isPuzzleStore } from '../../public/js/store/puzzle-store.js';
import { boardFromSnapshot, createRemoteStore, openRemoteStore, reasonOf } from '../../public/js/store/remote-store.js';

// 4 x 3 picture: pw = ph = 100. Group 9, me = 'a', friend = 'b'.
const layout = layoutFor(4, 3, 4 / 3);
const ME = 'a';

// A board row as PostgREST returns it (groups -> clusters -> pieces).
const cluster = (id, x, y, cells, extra = {}) => ({
  id,
  x,
  y,
  z: extra.z ?? id,
  locked: extra.locked ?? false,
  grabbed_by: extra.grabbed_by ?? null,
  grabbed_at: extra.grabbed_at ?? null,
  pieces: cells.map(([col, row, onBoard = true, owner = null]) => ({ col, row, on_board: onBoard, owner_id: owner })),
});

// Fake server side: answers are queued per call and come back like supabase-js ({ data, error });
// loadBoard returns `board` (changeable).
function fakeApi(board) {
  const api = {
    board,
    answers: { take: [], grab: [], drop: [] },
    calls: [],
    loads: 0,
    handlers: null,
    unsubscribed: false,
    async loadBoard(groupId) {
      api.calls.push(['loadBoard', groupId]);
      api.loads += 1;
      if (api.beforeLoad) await api.beforeLoad();
      return structuredClone(api.board);
    },
    async take(...args) {
      api.calls.push(['take', ...args]);
      return { data: api.answers.take.shift(), error: null };
    },
    async grab(...args) {
      api.calls.push(['grab', ...args]);
      return { data: api.answers.grab.shift(), error: null };
    },
    async drop(...args) {
      api.calls.push(['drop', ...args]);
      return { data: api.answers.drop.shift(), error: null };
    },
    subscribe(groupId, handlers) {
      api.handlers = handlers;
      return () => {
        api.unsubscribed = true;
      };
    },
    send(event, payload) {
      api.handlers.onEvent(event, payload);
    },
  };
  return api;
}

const timers = () => ({
  setTimeout: vi.fn(() => 1),
  clearTimeout: vi.fn(),
  setInterval: vi.fn(() => 2),
  clearInterval: vi.fn(),
});

// Tray: a owns pieces 0,1,2 (cells (0,0),(1,0),(2,0)); b owns 3. Board: cluster 20 = piece 5 (1,1).
function startBoard() {
  return {
    completed_at: null,
    clusters: [
      cluster(10, 0, 0, [[0, 0, false, ME]]),
      cluster(11, 0, 0, [[1, 0, false, ME]]),
      cluster(12, 0, 0, [[2, 0, false, ME]]),
      cluster(13, 0, 0, [[3, 0, false, 'b']]),
      cluster(20, 300, 200, [[1, 1]]),
      cluster(21, 500, 50, [[3, 2]], { grabbed_by: 'b', grabbed_at: '2026-10-07T00:00:05.000Z' }),
    ],
  };
}

async function open(board = startBoard(), extra = {}) {
  const api = fakeApi(board);
  const t = timers();
  const store = await openRemoteStore({
    api,
    groupId: 9,
    me: ME,
    layout,
    seed: 7,
    picture: { src: '/x.webp', width: 400, height: 300 },
    groupName: '1모둠',
    members: [
      { uid: ME, name: '가', color: 0, online: true },
      { uid: 'b', name: '나', color: 1, online: true },
    ],
    startedAt: 1000,
    now: () => Date.parse('2026-10-07T00:00:06.000Z'),
    timers: t,
    ...extra,
  });
  return { api, store, timers: t };
}

const ids = (state) => state.clusters.map((c) => c.id);

describe('reasonOf', () => {
  it('maps the server reasons 1:1 with dashes', () => {
    expect(reasonOf('not_in_tray')).toBe('not-in-tray');
    expect(reasonOf('held')).toBe('held');
    expect(reasonOf('not_playing')).toBe('not-playing');
    expect(reasonOf(undefined)).toBe('failed');
  });
});

describe('boardFromSnapshot', () => {
  it('keeps only clusters with pieces on the board and lists tray owners', () => {
    const { clusters, trayOwners } = boardFromSnapshot(startBoard(), 4, (iso) => Date.parse(iso));
    expect([...clusters.keys()]).toEqual([20, 21]);
    expect(clusters.get(21)).toMatchObject({ heldBy: 'b', heldAt: Date.parse('2026-10-07T00:00:05.000Z') });
    expect([...trayOwners]).toEqual([
      [0, ME],
      [1, ME],
      [2, ME],
      [3, 'b'],
    ]);
  });
});

describe('createRemoteStore', () => {
  it('implements the PuzzleStore contract and loads the board on open', async () => {
    const { store, api, timers: t } = await open();
    expect(isPuzzleStore(store)).toBe(true);
    const state = store.getState();
    expect(ids(state)).toEqual([20, 21]);
    expect([...state.tray].sort()).toEqual([0, 1, 2]);
    expect(state.progress).toEqual({ placed: 0, total: 12, complete: false });
    expect(state.hints).toEqual({ preview: false, outline: true, pictureButton: true, underlay: false });
    expect(state.clusters[1]).toMatchObject({ heldBy: 'b' });
    expect(api.calls).toEqual([['loadBoard', 9]]);
    expect(t.setInterval).toHaveBeenCalledWith(expect.any(Function), 15000);
  });

  it('orders the tray by the seed, not by the picture position', async () => {
    const board = startBoard();
    board.clusters = Array.from({ length: 12 }, (_, i) => cluster(100 + i, 0, 0, [[i % 4, Math.floor(i / 4), false, ME]]));
    const { store } = await open(board);
    const tray = store.getState().tray;
    expect([...tray].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(tray).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const again = await open(structuredClone(board));
    expect(again.store.getState().tray).toEqual(tray);
  });

  it('takes a tray piece: held by me at the clamped spot until drop() settles the server result', async () => {
    const { store, api } = await open();
    api.answers.take.push({
      ok: true,
      cluster_id: 10,
      piece: 0,
      id: 20,
      x: 200,
      y: 200,
      z: 7,
      locked: false,
      absorbed: [10],
      progress: { placed: 0, total: 12, complete: false },
    });
    const changes = [];
    store.subscribe((state, change) => changes.push(change.type));
    const taken = await store.takeFromTray(0, -5000, 210);
    expect(taken).toEqual({ ok: true, clusterId: 10 });
    expect(api.calls.at(-1)).toEqual(['take', 9, 0, -5000, 210]);
    let state = store.getState();
    expect(state.tray).not.toContain(0);
    expect(state.clusters.find((c) => c.id === 10)).toMatchObject({ x: 0, y: 210, heldBy: ME });

    const dropped = await store.drop(10, -5000, 210);
    expect(dropped).toEqual({ ok: true, id: 20, x: 200, y: 200, absorbed: [10], progress: { placed: 0, total: 12, complete: false } });
    expect(api.calls.filter(([name]) => name === 'drop')).toEqual([]); // no second call
    state = store.getState();
    expect(state.clusters.find((c) => c.id === 10)).toBeUndefined();
    expect(state.clusters.find((c) => c.id === 20)).toMatchObject({ x: 200, y: 200, z: 7, heldBy: null });
    expect(state.clusters.find((c) => c.id === 20).pieces).toEqual([
      [1, 1],
      [0, 0],
    ]);
    expect(changes).toEqual(['tray', 'take', 'drop']);
  });

  it('a piece leaves the tray at once and comes back if the take fails', async () => {
    const { store, api } = await open();
    let answer;
    api.take = () => new Promise((resolve) => (answer = resolve));
    const taking = store.takeFromTray(1, 10, 10);
    expect(store.getState().tray).not.toContain(1);
    // A board read meanwhile still has it in my tray on the server: it stays out.
    await store.resync();
    expect(store.getState().tray).not.toContain(1);
    answer({ data: { ok: false, reason: 'bad_position' }, error: null });
    expect(await taking).toEqual({ ok: false, reason: 'bad-position' });
    expect(store.getState().tray).toContain(1);

    api.take = async () => ({ data: null, error: { message: 'Failed to fetch' } });
    await expect(store.takeFromTray(2, 10, 10)).rejects.toThrow(/take_from_tray failed/);
    expect(store.getState().tray).toContain(2);
  });

  it('maps refusals and does not touch the tray', async () => {
    const { store, api } = await open();
    api.answers.take.push({ ok: false, reason: 'not_in_tray' });
    expect(await store.takeFromTray(1, 10, 10)).toEqual({ ok: false, reason: 'not-in-tray' });
    expect(store.getState().tray).toContain(1);
    expect(await store.takeFromTray(3, 10, 10)).toEqual({ ok: false, reason: 'not-in-tray' }); // b's piece: no call
    expect(api.calls.filter(([n]) => n === 'take')).toHaveLength(1);
  });

  it('grab: first one wins; a refused grab shows who holds it', async () => {
    const { store, api } = await open();
    api.answers.grab.push({ ok: true, cluster_id: 20, z: 40, grabbed_at: '2026-10-07T00:00:06.000Z' });
    expect(await store.grab(20)).toEqual({ ok: true });
    expect(store.getState().clusters.at(-1)).toMatchObject({ id: 20, heldBy: ME, z: 40 });

    api.answers.grab.push({ ok: false, reason: 'held', held_by: 'b' });
    expect(await store.grab(21)).toEqual({ ok: false, reason: 'held', heldBy: 'b' });
    api.answers.grab.push({ ok: false, reason: 'locked' });
    expect(await store.grab(20)).toEqual({ ok: false, reason: 'locked' });
    expect(await store.grab(999)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('throws a StoreError on transport errors (the screen shows a message and resyncs)', async () => {
    const { store, api } = await open();
    api.grab = async () => ({ data: null, error: { message: 'Failed to fetch' } });
    await expect(store.grab(20)).rejects.toThrow(/grab failed/);
  });

  it('applies friends\' broadcasts: grab, drop with merge, take, tray, release', async () => {
    const { store, api } = await open();
    api.send('grab', { by: 'b', cluster_id: 20, z: 30, grabbed_at: '2026-10-07T00:00:06.000Z', id: 'f3e1c0de-0000-4000-8000-000000000000' });
    expect(store.getState().clusters.at(-1)).toMatchObject({ id: 20, heldBy: 'b', z: 30 });

    api.send('drop', { by: 'b', cluster_id: 20, id: 21, x: 77, y: 88, z: 31, locked: false, absorbed: [20] });
    let state = store.getState();
    expect(ids(state)).toEqual([21]);
    expect(state.clusters[0]).toMatchObject({ x: 77, y: 88, heldBy: null });
    expect(state.clusters[0].pieces).toHaveLength(2);

    api.send('take', { by: 'b', cluster_id: 13, piece: 3, id: 13, x: 5, y: 6, z: 32, locked: false, absorbed: [] });
    expect(ids(store.getState())).toEqual([21, 13]);

    api.send('tray', { pieces: [{ col: 0, row: 2, owner: ME }, { col: 0, row: 0, owner: 'b' }], id: 'uuid-from-realtime' });
    state = store.getState();
    expect(state.tray).toContain(8);
    expect(state.tray).not.toContain(0);

    api.send('grab', { by: 'b', cluster_id: 13, z: 33, grabbed_at: '2026-10-07T00:00:06.000Z' });
    api.send('release', { clusters: [13] });
    expect(store.getState().clusters.find((c) => c.id === 13).heldBy).toBeNull();
  });

  it('ignores the echo of my own grab/drop/take and unknown events', async () => {
    const { store, api } = await open();
    api.answers.grab.push({ ok: true, cluster_id: 20, z: 9, grabbed_at: '2026-10-07T00:00:06.000Z' });
    await store.grab(20);
    api.answers.drop.push({ ok: true, cluster_id: 20, id: 20, x: 1, y: 2, z: 9, locked: false, absorbed: [] });
    await store.drop(20, 1, 2);
    api.send('grab', { by: ME, cluster_id: 20, z: 9, grabbed_at: '2026-10-07T00:00:06.000Z' });
    expect(store.getState().clusters.find((c) => c.id === 20).heldBy).toBeNull();
    const before = store.getState();
    api.send('presence_diff', { anything: 1 });
    expect(store.getState()).toBe(before);
  });

  it('marks completion from a drop result, and progress counts locked pieces', async () => {
    const board = startBoard();
    board.clusters = [cluster(20, 300, 200, [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2]]), cluster(30, 10, 10, [[3, 2]])];
    const { store, api } = await open(board);
    const f = frameOrigin(layout);
    api.send('drop', {
      by: 'b',
      cluster_id: 30,
      id: 20,
      x: f.x,
      y: f.y,
      z: 40,
      locked: true,
      absorbed: [30],
      completed_at: '2026-10-07T00:00:06.000Z',
      completed_now: true,
    });
    const state = store.getState();
    expect(state.progress).toEqual({ placed: 12, total: 12, complete: true });
    expect(state.completedAt).toBe(Date.parse('2026-10-07T00:00:06.000Z'));
  });

  it('resyncs when an event does not fit the board here (a missed broadcast)', async () => {
    const { store, api } = await open();
    api.board.clusters.push(cluster(50, 1, 1, [[0, 2]]));
    api.send('drop', { by: 'b', cluster_id: 50, id: 50, x: 9, y: 9, z: 50, locked: false, absorbed: [] });
    await vi.waitFor(() => expect(api.loads).toBe(2));
    await vi.waitFor(() => expect(ids(store.getState())).toContain(50));
  });

  it('events that arrive while a snapshot loads are applied on top of it', async () => {
    const { store, api } = await open();
    let release;
    api.beforeLoad = () => new Promise((resolve) => (release = resolve));
    const loading = store.resync();
    // The snapshot was taken before this drop: the drop must survive the reload.
    api.send('drop', { by: 'b', cluster_id: 20, id: 20, x: 123, y: 45, z: 60, locked: false, absorbed: [] });
    release();
    await loading;
    expect(store.getState().clusters.find((c) => c.id === 20)).toMatchObject({ x: 123, y: 45 });
  });

  it('one load at a time: requests during a load run once more afterwards', async () => {
    const { store, api } = await open();
    let release;
    api.beforeLoad = () => new Promise((resolve) => (release = resolve));
    const first = store.resync();
    store.resync();
    store.resync();
    release();
    api.beforeLoad = null;
    await first;
    await vi.waitFor(() => expect(api.loads).toBe(3)); // open + this one + one queued
  });

  it('reloads when the channel (re)subscribes and on the timer', async () => {
    const { api, timers: t } = await open();
    api.handlers.onStatus('SUBSCRIBED');
    await vi.waitFor(() => expect(api.loads).toBe(2));
    t.setInterval.mock.calls[0][0]();
    await vi.waitFor(() => expect(api.loads).toBe(3));
  });

  it('an end broadcast ends the class once; not_playing asks the owner to check', async () => {
    const onEnd = vi.fn();
    const onNotPlaying = vi.fn();
    const { store, api } = await open(startBoard(), { onEnd, onNotPlaying });
    api.send('end', { session_id: 1 });
    api.send('end', { session_id: 1 });
    expect(onEnd).toHaveBeenCalledTimes(1);
    api.answers.drop.push({ ok: false, reason: 'not_playing' });
    expect(await store.drop(20, 1, 1)).toEqual({ ok: false, reason: 'not-playing' });
    expect(onNotPlaying).toHaveBeenCalledTimes(1);
  });

  it('heldAt uses this device\'s clock (server offset from grab answers)', async () => {
    let clock = Date.parse('2026-10-07T00:00:00.000Z');
    const { store, api } = await open(startBoard(), { now: () => clock });
    // The server is 60 s ahead: grabbed_at is server time.
    api.grab = async () => {
      clock += 100;
      return { data: { ok: true, cluster_id: 20, z: 9, grabbed_at: '2026-10-07T00:01:00.050Z' }, error: null };
    };
    await store.grab(20);
    expect(store.clockOffset).toBe(60_000);
    api.send('grab', { by: 'b', cluster_id: 20, z: 10, grabbed_at: '2026-10-07T00:01:01.000Z' });
    expect(store.getState().clusters.find((c) => c.id === 20).heldAt).toBe(Date.parse('2026-10-07T00:00:01.000Z'));
  });

  it('members come from outside (Presence) and dispose stops everything', async () => {
    const { store, api, timers: t } = await open();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setMembers([{ uid: ME, name: '가', color: 0, online: true }, { uid: 'b', name: '나', color: 1, online: false }]);
    expect(store.getState().members[1]).toMatchObject({ uid: 'b', online: false });
    expect(listener).toHaveBeenCalledTimes(1);
    // The same list again (the class is read every few seconds): no redraw.
    store.setMembers([{ uid: ME, name: '가', color: 0, online: true }, { uid: 'b', name: '나', color: 1, online: false }]);
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispose();
    expect(api.unsubscribed).toBe(true);
    expect(t.clearInterval).toHaveBeenCalled();
    api.send('grab', { by: 'b', cluster_id: 20, z: 1, grabbed_at: '2026-10-07T00:00:06.000Z' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('createRemoteStore does not load until asked', () => {
    const api = fakeApi(startBoard());
    createRemoteStore({ api, groupId: 9, me: ME, layout, seed: 7, picture: {}, groupName: '', startedAt: 0, timers: timers() });
    expect(api.loads).toBe(0);
  });
});
