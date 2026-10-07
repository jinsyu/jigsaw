// Runs and checks tests/fixtures/snap-cases.json cases on the JS side.
// Shared by tests/unit/snap.test.js and tests/server/board.test.js.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { layoutFor } from '../../public/js/puzzle/geometry.js';
import { resolveDropWithHolds } from '../../public/js/puzzle/snap.js';

export const table = JSON.parse(readFileSync(new URL('./snap-cases.json', import.meta.url), 'utf8'));

export const POSITION_EPSILON = 1e-9;

// Fixed clock for hold cases: a cluster with heldMsAgo was grabbed at NOW - heldMsAgo.
export const NOW = Date.parse('2026-01-01T00:00:00.000Z');

export const byOf = (input) => input.by ?? 'me';
export const onlineOf = (input) => input.online ?? [];
export const hasHolds = (input) => input.clusters.some((c) => c.heldBy !== undefined);

function withHeldAt(clusters) {
  return clusters.map(({ heldMsAgo, ...c }) =>
    heldMsAgo === undefined ? c : { ...c, heldAt: NOW - heldMsAgo },
  );
}

export function runCase(input) {
  const { grid, clusters, drop, tolerance } = input;
  const layout = layoutFor(grid.cols, grid.rows, grid.aspect);
  const online = onlineOf(input);
  const holds = { me: byOf(input), now: NOW, isOnline: (uid) => online.includes(uid) };
  return resolveDropWithHolds(layout, withHeldAt(clusters), drop, holds, tolerance);
}

export function expectPosition(actual, expected) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(POSITION_EPSILON);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(POSITION_EPSILON);
}

export function expectCaseResult(result, expected) {
  expect(result.id).toBe(expected.id);
  expectPosition(result, expected);
  expect(result.locked).toBe(expected.locked);
  expect(result.absorbed).toEqual(expected.absorbed);
  expect(result.placed).toBe(expected.placed);
  expect(result.total).toBe(expected.total);
  expect(result.complete).toBe(expected.complete);
  expect(result.clusters.map((c) => c.id)).toEqual(expected.clusters.map((c) => c.id));
  result.clusters.forEach((c, i) => {
    const want = expected.clusters[i];
    expect(c.pieces).toEqual(want.pieces);
    expect(c.locked).toBe(want.locked);
    expectPosition(c, want);
  });
}
