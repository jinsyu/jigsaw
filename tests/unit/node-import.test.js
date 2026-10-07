// @vitest-environment node
// T14 (D7): the puzzle rules load and run in plain Node with no DOM or browser globals, so
// the rt server (T15) can import public/js/puzzle/* itself instead of keeping a copy.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectCaseResult, table } from '../fixtures/snap-case.js';

// Modules the server engine shares with the screens (rules, deal order, store contract).
const SHARED_MODULES = [
  'public/js/puzzle/geometry.js',
  'public/js/puzzle/snap.js',
  'public/js/store/puzzle-store.js',
  'public/js/store/local-store.js',
  'public/js/play/magnet.js',
];

const ROOT_URL = new URL('../../', import.meta.url);
const ROOT = fileURLToPath(ROOT_URL);

// Runs in a fresh `node` process: no Vitest, no jsdom, nothing but Node's own globals.
const SCRIPT = `
const root = new URL(process.argv[1]);
// DOM-only names (Node itself has navigator and, in newer versions, localStorage).
const browserGlobals = ['window', 'document', 'Path2D', 'HTMLElement', 'Image', 'CanvasRenderingContext2D']
  .filter((name) => typeof globalThis[name] !== 'undefined');
const modules = JSON.parse(process.argv[2]);
for (const path of modules) await import(new URL(path, root));
const { layoutFor, makePuzzle, toPath2D } = await import(new URL('public/js/puzzle/geometry.js', root));
const { resolveDropWithHolds } = await import(new URL('public/js/puzzle/snap.js', root));
const { readFileSync } = await import('node:fs');
const table = JSON.parse(readFileSync(new URL('tests/fixtures/snap-cases.json', root), 'utf8'));
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const results = table.cases.map(({ input }) => {
  const layout = layoutFor(input.grid.cols, input.grid.rows, input.grid.aspect);
  const clusters = input.clusters.map(({ heldMsAgo, ...c }) =>
    heldMsAgo === undefined ? c : { ...c, heldAt: NOW - heldMsAgo });
  const online = input.online ?? [];
  const holds = { me: input.by ?? 'me', now: NOW, isOnline: (uid) => online.includes(uid) };
  return resolveDropWithHolds(layout, clusters, input.drop, holds, input.tolerance);
});
const puzzle = makePuzzle(layoutFor(4, 3, 4 / 3), 7);
let path2D = 'ok';
try { toPath2D(puzzle.pieces[0]); } catch (error) { path2D = error.name; }
process.stdout.write(JSON.stringify({ browserGlobals, results, pieces: puzzle.pieces.length, path2D }));
`;

function runInPlainNode() {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', SCRIPT, ROOT_URL.href, JSON.stringify(SHARED_MODULES)],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return JSON.parse(out);
}

describe('퍼즐 모듈을 Node 에서 쓴다 (D7, 서버 판정 준비)', () => {
  it.each(SHARED_MODULES)('%s 는 Vitest node 환경에서 import 된다', async (path) => {
    expect(typeof globalThis.document).toBe('undefined');
    await expect(import(new URL(path, ROOT_URL).href)).resolves.toBeTruthy();
  });

  const run = runInPlainNode();

  it('브라우저 전역이 없는 순수 node 프로세스에서 모든 공용 모듈이 import 된다', () => {
    expect(run.browserGlobals).toEqual([]);
    expect(run.pieces).toBe(12);
  });

  it.each(table.cases.map((c, i) => [c.name, i]))('순수 node 에서 resolveDropWithHolds: %s', (_name, i) => {
    expectCaseResult(run.results[i], table.cases[i].expected);
  });

  it('Path2D 는 toPath2D 를 부를 때만 쓰인다 (Node 에서는 그 호출만 실패)', () => {
    expect(run.path2D).toBe('ReferenceError');
  });
});
