import { describe, expect, it } from 'vitest';
import { layoutFor, makePuzzle } from '../../public/js/puzzle/geometry.js';
import { SNAP_TOLERANCE, frameOrigin, grabRefusal } from '../../public/js/puzzle/snap.js';
import { PULL, predictDrop, pullOffset, sideSegments, snapPreview } from '../../public/js/play/magnet.js';
import { NOW, byOf, expectCaseResult, onlineOf, runCase, table } from '../fixtures/snap-case.js';
import { createLocalStore } from '../../public/js/store/local-store.js';

const layout = layoutFor(6, 4, 1.5); // pw = ph = 100
const T = frameOrigin(layout);
const solo = { me: 'me', now: NOW, isOnline: () => true };

// Store snapshots carry heldBy but maybe no heldAt; the fixture gives heldMsAgo.
const snapshotOf = (clusters) =>
  clusters.map(({ heldMsAgo, ...c }) => (heldMsAgo === undefined ? c : { ...c, heldAt: NOW - heldMsAgo }));

describe('predictDrop (what the drag preview shows)', () => {
  describe.each(table.cases)('$name', ({ input, expected }) => {
    it('gives the same result as the shared snap rules', () => {
      const { grid, clusters, drop, tolerance } = input;
      if (tolerance !== SNAP_TOLERANCE) return; // the screen always uses the default tolerance
      const lay = layoutFor(grid.cols, grid.rows, grid.aspect);
      const online = onlineOf(input);
      const holds = { me: byOf(input), now: NOW, isOnline: (uid) => online.includes(uid) };
      const predicted = predictDrop(lay, snapshotOf(clusters), drop, holds);
      expectCaseResult(predicted, expected);
      expect(predicted).toEqual(runCase(input));
    });
  });

  it('treats a hold without a time as fresh (left out of the merge while the holder is online)', () => {
    const clusters = [
      { id: 1, x: 200, y: 150, pieces: [[0, 0]], heldBy: 'friend' },
      { id: 2, x: 0, y: 0, pieces: [[1, 0]], heldBy: 'me' },
    ];
    const drop = { id: 2, x: 205, y: 150 };
    expect(predictDrop(layout, clusters, drop, { ...solo, isOnline: () => true }).absorbed).toEqual([]);
    expect(predictDrop(layout, clusters, drop, { ...solo, isOnline: () => false }).absorbed).toHaveLength(1);
  });

  it('matches what the local store does on drop, locked clusters included', async () => {
    const store = createLocalStore({
      layout,
      seed: 1,
      picture: { src: '', width: 600, height: 400 },
      groupName: 'g',
      me: 'me',
      members: [{ uid: 'me', name: '나', color: 0 }],
      trays: { me: [0, 1, 2, 7] },
    });
    const place = async (piece, x, y) => {
      const taken = await store.takeFromTray(piece, x, y);
      const before = store.getState().clusters;
      const predicted = predictDrop(layout, before, { id: taken.clusterId, x, y }, solo);
      const actual = await store.drop(taken.clusterId, x, y);
      expect({ id: actual.id, x: actual.x, y: actual.y, absorbed: actual.absorbed }).toEqual({
        id: predicted.id,
        x: predicted.x,
        y: predicted.y,
        absorbed: predicted.absorbed,
      });
      expect(store.getState().progress.placed).toBe(predicted.placed);
    };
    await place(0, T.x + 12, T.y - 9); // locks into the frame
    await place(1, T.x + 25, T.y + 20); // joins the locked piece
    await place(7, 30, 20); // far away: stays
    await place(2, T.x - 30, T.y + 10); // joins the locked pair
    expect(store.getState().progress.placed).toBe(3);
  });
});

describe('snapPreview', () => {
  it('is null when the drop would not snap', () => {
    const clusters = [{ id: 1, x: 30, y: 30, pieces: [[0, 0]] }];
    expect(snapPreview(layout, clusters, { id: 1, x: 10, y: 10 }, solo)).toBeNull();
  });

  it('shows the frame cell when a piece is near its place', () => {
    const clusters = [{ id: 1, x: 0, y: 0, pieces: [[2, 1]] }];
    const p = snapPreview(layout, clusters, { id: 1, x: T.x + 20, y: T.y - 15 }, solo);
    expect(p).toMatchObject({ x: T.x, y: T.y, frameLock: true, edges: [] });
    expect(p.moving).toEqual([[2, 1]]);
    expect(p.distance).toBeCloseTo(25, 9);
  });

  it('shows the touching edges when it would join a neighbour', () => {
    const clusters = [
      { id: 1, x: 300, y: 50, pieces: [[0, 0], [0, 1]] }, // stays (bigger)
      { id: 2, x: 0, y: 0, pieces: [[1, 0]] },
    ];
    const p = snapPreview(layout, clusters, { id: 2, x: 310, y: 45 }, solo);
    expect(p).toMatchObject({ x: 300, y: 50, frameLock: false });
    expect(p.moving).toEqual([[1, 0]]);
    expect(p.edges).toEqual([{ cell: [1, 0], side: 'left' }]);
  });

  it('when the dragged cluster is the anchor, the neighbour is the one that moves', () => {
    const clusters = [
      { id: 1, x: 300, y: 50, pieces: [[0, 0]] },
      { id: 2, x: 0, y: 0, pieces: [[1, 0], [1, 1]] },
    ];
    const p = snapPreview(layout, clusters, { id: 2, x: 310, y: 45 }, solo);
    expect(p).toMatchObject({ x: 310, y: 45, distance: 0 });
    expect(p.moving).toEqual([[0, 0]]);
    expect(p.edges).toEqual([{ cell: [1, 0], side: 'left' }]);
  });

  it('joining a locked neighbour shows its edge (the locked one never moves)', () => {
    const clusters = [
      { id: 1, x: T.x, y: T.y, locked: true, pieces: [[0, 0], [1, 0], [2, 0]] },
      { id: 2, x: 0, y: 0, pieces: [[1, 1], [2, 1], [3, 1], [3, 2]] }, // bigger, but not locked
    ];
    const p = snapPreview(layout, clusters, { id: 2, x: T.x + 20, y: T.y + 20 }, solo);
    expect(p).toMatchObject({ x: T.x, y: T.y, frameLock: false });
    expect(p.moving).toEqual([[1, 1], [2, 1], [3, 1], [3, 2]]);
    expect(p.edges).toEqual([
      { cell: [1, 1], side: 'top' },
      { cell: [2, 1], side: 'top' },
    ]);
  });
});

describe('pullOffset (the piece leans toward where it will snap)', () => {
  const at = { x: 100, y: 100 };
  const toward = (d) => ({ x: at.x + d, y: at.y, distance: d });

  it('does nothing without a snap or at the edge of the tolerance', () => {
    expect(pullOffset(null, at)).toEqual({ x: 0, y: 0 });
    expect(pullOffset(toward(SNAP_TOLERANCE), at).x).toBe(0);
  });

  it('grows smoothly inside the tolerance and stays a small part of the gap', () => {
    let last = 0;
    for (let d = SNAP_TOLERANCE; d >= 0; d -= 1) {
      const { x } = pullOffset(toward(d), at);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(PULL * d + 1e-9);
      expect(Math.abs(x - last)).toBeLessThan(2); // no jumps
      last = x;
    }
  });
});

describe('sideSegments', () => {
  it('splits a piece outline into its four sides', () => {
    const puzzle = makePuzzle(layout, 42);
    for (const piece of puzzle.pieces) {
      const sides = ['top', 'right', 'bottom', 'left'].map((s) => sideSegments(piece, s, layout.cols, layout.rows));
      expect(sides.flat()).toEqual(piece.segments);
      const [x0, y0, x1, y1] = [piece.x0, piece.y0, piece.x0 + 100, piece.y0 + 100];
      expect(sides[0][0][0]).toEqual([x0, y0]);
      expect(sides[1][0][0]).toEqual([x1, y0]);
      expect(sides[2][0][0]).toEqual([x1, y1]);
      expect(sides[3][0][0]).toEqual([x0, y1]);
    }
  });
});

describe('grab refusal for locked pieces', () => {
  it('a locked cluster cannot be grabbed, by anyone', async () => {
    expect(grabRefusal({ id: 1, locked: true, heldBy: null }, 'me', NOW, () => true)).toBe('locked');
    const store = createLocalStore({
      layout,
      seed: 1,
      picture: { src: '', width: 600, height: 400 },
      groupName: 'g',
      me: 'me',
      members: [{ uid: 'me', name: '나', color: 0 }],
      trays: { me: [0] },
    });
    const taken = await store.takeFromTray(0, T.x + 5, T.y + 5);
    await store.drop(taken.clusterId, T.x + 5, T.y + 5);
    const [locked] = store.getState().clusters;
    expect(locked.locked).toBe(true);
    expect(await store.grab(locked.id)).toEqual({ ok: false, reason: 'locked' });
  });
});
