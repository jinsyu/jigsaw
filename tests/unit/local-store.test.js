import { describe, expect, it, vi } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { createLocalStore, shuffledPieces } from '../../public/js/store/local-store.js';
import { isPuzzleStore, pieceOfCell } from '../../public/js/store/puzzle-store.js';

// 4 x 3 picture of 400 x 300 units: pw = ph = 100, board ~566 x 424.
const layout = layoutFor(4, 3, 4 / 3);
const ALL = Array.from({ length: 12 }, (_, i) => i);

function makeStore(overrides = {}) {
  return createLocalStore({
    layout,
    seed: 7,
    picture: { src: '/images/demo/sea.svg', width: 600, height: 400 },
    groupName: '1모둠',
    me: 'a',
    members: [
      { uid: 'a', name: '나', color: 0 },
      { uid: 'b', name: '친구', color: 1 },
    ],
    trays: { a: [0, 1, 2, 3, 4, 5], b: [6, 7, 8, 9, 10, 11] },
    now: () => 1000,
    ...overrides,
  });
}

// Takes a piece from my tray and drops it with its picture origin at (x, y).
async function place(store, piece, x, y) {
  const taken = await store.takeFromTray(piece, x, y);
  expect(taken.ok).toBe(true);
  return store.drop(taken.clusterId, x, y);
}

describe('createLocalStore', () => {
  it('implements the PuzzleStore contract', () => {
    expect(isPuzzleStore(makeStore())).toBe(true);
    expect(isPuzzleStore({ getState() {} })).toBe(false);
  });

  it('starts with an empty board and only my pieces in the tray', () => {
    const state = makeStore().getState();
    expect(state.clusters).toEqual([]);
    expect(state.tray).toEqual([0, 1, 2, 3, 4, 5]);
    expect(state.progress).toEqual({ placed: 0, total: 12, complete: false });
    expect(state.members.map((m) => m.uid)).toEqual(['a', 'b']);
    expect(state.completedAt).toBeNull();
  });

  it('takes my piece onto the board, held by me, and notifies listeners', async () => {
    const store = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const result = await store.takeFromTray(1, 50, 60);

    expect(result).toEqual({ ok: true, clusterId: expect.any(Number) });
    const state = store.getState();
    expect(state.tray).toEqual([0, 2, 3, 4, 5]);
    expect(state.clusters).toEqual([
      { id: result.clusterId, x: 50, y: 60, z: expect.any(Number), locked: false, heldBy: 'a', pieces: [[1, 0]] },
    ]);
    expect(listener).toHaveBeenCalledWith(state, expect.objectContaining({ type: 'take', piece: 1 }));
  });

  it("refuses pieces from another member's tray and pieces already taken", async () => {
    const store = makeStore();
    expect(await store.takeFromTray(7, 0, 0)).toEqual({ ok: false, reason: 'not-in-tray' });
    await store.takeFromTray(0, 0, 0);
    expect(await store.takeFromTray(0, 0, 0)).toEqual({ ok: false, reason: 'not-in-tray' });
    expect(store.getState().clusters).toHaveLength(1);
    expect(store.getState().tray).toEqual([1, 2, 3, 4, 5]);
  });

  it('clamps a piece taken outside the board', async () => {
    const store = makeStore();
    await store.takeFromTray(0, -500, 9999);
    const [cluster] = store.getState().clusters;
    expect(cluster.x).toBe(0);
    expect(cluster.y).toBeCloseTo(layout.boardHeight - layout.ph, 9);
  });

  it('snaps a dropped piece to its neighbour with the snap.js rules', async () => {
    const store = makeStore();
    await place(store, 0, 100, 100);
    const result = await place(store, 1, 100 + 20, 100 - 10);

    expect(result.ok).toBe(true);
    expect(result.absorbed).toHaveLength(1);
    // Joined but not in the frame yet: progress counts locked pieces only.
    expect(result.progress).toEqual({ placed: 0, total: 12, complete: false });
    const { clusters, progress } = store.getState();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ x: 100, y: 100, heldBy: null });
    expect(clusters[0].pieces).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(progress.placed).toBe(0);
  });

  it('does not snap outside the tolerance or to diagonal pieces', async () => {
    const store = makeStore();
    await place(store, 0, 100, 100);
    await place(store, 1, 100 + 41, 100);
    await place(store, 5, 100, 100); // (1, 1) is diagonal to (0, 0) but below (1, 0)
    // (1, 1) touches (1, 0) which sits at +41: 41 > 40, so no merge at all.
    expect(store.getState().clusters).toHaveLength(3);
    expect(store.getState().progress.placed).toBe(0);
  });

  it('moves merged clusters together', async () => {
    const store = makeStore();
    await place(store, 0, 100, 100);
    await place(store, 1, 100, 100);
    const [merged] = store.getState().clusters;

    expect((await store.grab(merged.id)).ok).toBe(true);
    await store.drop(merged.id, 150, 120);

    const [moved] = store.getState().clusters;
    expect(moved).toMatchObject({ id: merged.id, x: 150, y: 120 });
    expect(moved.pieces).toHaveLength(2);
  });

  it('only lets the holder drop, and refuses clusters held by someone else', async () => {
    const store = makeStore({
      clusters: [
        { id: 50, x: 10, y: 10, pieces: [[3, 2]], heldBy: 'b' },
        { id: 51, x: 200, y: 10, pieces: [[2, 2]] },
      ],
    });
    expect(await store.grab(50)).toEqual({ ok: false, reason: 'held', heldBy: 'b' });
    expect(await store.drop(50, 0, 0)).toEqual({ ok: false, reason: 'not-held' });
    expect(await store.drop(51, 0, 0)).toEqual({ ok: false, reason: 'not-held' });
    expect(await store.grab(999)).toEqual({ ok: false, reason: 'not-found' });
    expect(store.getState().clusters.find((c) => c.id === 50)).toMatchObject({ x: 10, y: 10, heldBy: 'b' });
  });

  it('refuses to grab or drop a cluster locked in the frame, and progress stays', async () => {
    const store = makeStore();
    const frameX = (layout.boardWidth - layout.width) / 2;
    const frameY = (layout.boardHeight - layout.height) / 2;
    const placed = await place(store, 0, frameX + 5, frameY - 5);
    expect(placed).toMatchObject({ ok: true, x: frameX, y: frameY, progress: { placed: 1 } });
    const before = store.getState();
    const [locked] = before.clusters;
    expect(locked.locked).toBe(true);

    expect(await store.grab(locked.id)).toEqual({ ok: false, reason: 'locked' });
    expect(await store.drop(locked.id, 300, 300)).toEqual({ ok: false, reason: 'locked' });
    const after = store.getState();
    expect(after).toBe(before);
    expect(after.clusters[0]).toMatchObject({ x: frameX, y: frameY, locked: true, heldBy: null });
    expect(after.progress).toEqual({ placed: 1, total: 12, complete: false });
  });

  it('raises a grabbed cluster to the top', async () => {
    const store = makeStore();
    await place(store, 0, 0, 0);
    await place(store, 3, 300, 200);
    const bottom = store.getState().clusters[0];
    await store.grab(bottom.id);
    expect(store.getState().clusters.at(-1).id).toBe(bottom.id);
  });

  it('completes when every piece is one cluster and records the time once', async () => {
    let clock = 1000;
    const store = makeStore({ trays: { a: shuffledPieces(12, 3), b: [] }, now: () => clock });
    const changes = [];
    store.subscribe((_, change) => changes.push(change));
    clock = 61_000;
    for (const piece of store.getState().tray) await place(store, piece, 80, 60);

    const state = store.getState();
    expect(state.clusters).toHaveLength(1);
    expect(state.progress).toEqual({ placed: 12, total: 12, complete: true });
    expect(state.completedAt).toBe(61_000);
    expect(state.completedAt - state.startedAt).toBe(60_000);
    expect(changes.filter((c) => c.completed)).toHaveLength(1);
  });

  it('keeps old snapshots unchanged and frozen', async () => {
    const store = makeStore();
    const before = store.getState();
    expect(store.getState()).toBe(before);
    await place(store, 0, 0, 0);
    expect(before.clusters).toEqual([]);
    expect(before.tray).toHaveLength(6);
    expect(Object.isFrozen(store.getState().clusters[0].pieces)).toBe(true);
  });

  it('stops notifying after unsubscribe and dispose', async () => {
    const store = makeStore();
    const first = vi.fn();
    const second = vi.fn();
    const off = store.subscribe(first);
    store.subscribe(second);
    off();
    await store.takeFromTray(0, 0, 0);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    store.dispose();
    await store.takeFromTray(1, 0, 0);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('shuffledPieces', () => {
  it('is a deterministic permutation', () => {
    const a = shuffledPieces(24, 42);
    expect(a).toEqual(shuffledPieces(24, 42));
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(a).not.toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it('maps cells and piece indexes both ways', () => {
    expect(ALL.map((i) => pieceOfCell([i % 4, Math.floor(i / 4)], 4))).toEqual(ALL);
  });
});
