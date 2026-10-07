// E2E helpers for a student's puzzle screen (coop.spec.js, overview.spec.js): real touch through
// CDP on touch projects, the mouse otherwise, and the screen's read-only test hook.
import { expect } from '@playwright/test';

export function makeInput(page, testInfo) {
  const hasTouch = testInfo.project.use.hasTouch === true;
  let cdp = null;
  const session = async () => (cdp ??= await page.context().newCDPSession(page));
  const touch = async (type, points) =>
    (await session()).send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

  // Presses along `path` and keeps holding; resolves to a function that lifts the finger.
  async function hold(path, steps = 6) {
    const [start, ...rest] = path;
    if (hasTouch) await touch('touchStart', [start]);
    else {
      await page.mouse.move(start[0], start[1]);
      await page.mouse.down();
    }
    let prev = start;
    for (const point of rest) {
      for (let k = 1; k <= steps; k++) {
        const p = [prev[0] + ((point[0] - prev[0]) * k) / steps, prev[1] + ((point[1] - prev[1]) * k) / steps];
        if (hasTouch) await touch('touchMove', [p]);
        else await page.mouse.move(p[0], p[1]);
      }
      prev = point;
    }
    return async () => {
      if (hasTouch) await touch('touchEnd', []);
      else await page.mouse.up();
    };
  }

  async function pinch(centre, d0, d1, steps = 8) {
    const at = (d) => [
      [centre[0] - d / 2, centre[1]],
      [centre[0] + d / 2, centre[1]],
    ];
    await touch('touchStart', at(d0));
    for (let k = 1; k <= steps; k++) await touch('touchMove', at(d0 + ((d1 - d0) * k) / steps));
    await touch('touchEnd', []);
  }

  return { hasTouch, hold, pinch, drag: async (path, steps) => (await hold(path, steps))() };
}

export const puzzleState = (page) => page.evaluate(() => window.__puzzle.state());
export const toClient = (page, x, y) => page.evaluate(([bx, by]) => window.__puzzle.boardToClient(bx, by), [x, y]);
export const boardBox = (page) => page.locator('.pz-canvas').boundingBox();

export async function frameOrigin(page) {
  const { layout } = await puzzleState(page);
  return { layout, ox: (layout.boardWidth - layout.width) / 2, oy: (layout.boardHeight - layout.height) / 2 };
}

// Zoom out until the whole frame is on screen (phones start zoomed in).
export async function showFrame(page, input) {
  const { layout, ox, oy } = await frameOrigin(page);
  for (let k = 0; k < 5; k++) {
    const board = await boardBox(page);
    const a = await toClient(page, ox - layout.pw, oy - layout.ph);
    const b = await toClient(page, ox + layout.width + layout.pw, oy + layout.height + layout.ph);
    if (a.x >= board.x && a.y >= board.y && b.x <= board.x + board.width && b.y <= board.y + board.height) return;
    const centre = [board.x + board.width / 2, board.y + board.height / 2];
    if (input.hasTouch) {
      const d0 = Math.min(board.width, board.height) * 0.7;
      await input.pinch(centre, d0, d0 * 0.5);
    } else {
      await page.mouse.move(centre[0], centre[1]);
      await page.mouse.wheel(0, 400);
    }
    await page.waitForTimeout(250);
  }
}

// Client point at the centre of piece `cell` of a cluster whose picture origin is (x, y).
export async function cellPoint(page, x, y, [col, row]) {
  const { layout } = await puzzleState(page);
  return toClient(page, x + (col + 0.5) * layout.pw, y + (row + 0.5) * layout.ph);
}

// Drags tray piece `index` so that its picture origin lands on (ox, oy) (its place in the
// frame when (ox, oy) is the frame origin).
export async function dragFromTray(page, input, index, ox, oy) {
  const { layout } = await puzzleState(page);
  const tile = page.locator(`.pz-tile[data-piece="${index}"]`);
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  const start = [box.x + box.width / 2, box.y + box.height / 2];
  const target = await cellPoint(page, ox, oy, [index % layout.cols, Math.floor(index / layout.cols)]);
  const board = await boardBox(page);
  const out = board.y + board.height < box.y ? [start[0], start[1] - 40] : [start[0] - 40, start[1]];
  await input.drag([start, out, [target.x, target.y]]);
}

// Puts every tray piece of this student into its place in the frame.
export async function placeAll(page, input) {
  await showFrame(page, input);
  const { ox, oy } = await frameOrigin(page);
  for (const piece of (await puzzleState(page)).tray) await dragFromTray(page, input, piece, ox, oy);
}

// Drags the loose clusters on this screen into their place in the frame until the puzzle is
// complete (pieces dropped next to each other may have joined before reaching the frame).
export async function finishFrame(page, input) {
  const { ox, oy } = await frameOrigin(page);
  for (let round = 0; round < 3 && !(await puzzleState(page)).progress.complete; round++) {
    for (const loose of (await puzzleState(page)).clusters.filter((c) => !c.locked)) {
      const from = await cellPoint(page, loose.x, loose.y, loose.pieces[0]);
      const to = await cellPoint(page, ox, oy, loose.pieces[0]);
      await input.drag([
        [from.x, from.y],
        [to.x, to.y],
      ]);
    }
    await page.waitForTimeout(500);
  }
}

export async function expectNoHorizontalOverflow(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}
