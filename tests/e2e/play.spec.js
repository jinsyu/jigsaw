import { expect, test } from '@playwright/test';
import { TALL, WIDE } from './support/pictures.js';

// Student puzzle screen, solo demo (/play?demo=1): in-memory store, 24 pieces (6 x 4)
// unless &pieces= asks for 12, 48 or 70. Help settings (spec rule 10) by address too:
// &preview=1 &outline=0 &button=0 &underlay=1, and &picture=<built-in key>.
// Touch projects drive real touch input through CDP; the desktop project uses the mouse.

// options: extra address parameters, e.g. { pieces: 70, preview: 1 }.
async function openDemo(page, options = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const params = new URLSearchParams({ demo: '1', picture: WIDE });
  for (const [key, value] of Object.entries(options)) params.set(key, String(value));
  await page.goto(`/play?${params}`);
  await expect(page.locator('main[data-ready="true"]')).toBeVisible();
  return errors;
}

const demo = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => demo(page, () => window.__puzzleDemo.state());
const camera = (page) => demo(page, () => window.__puzzleDemo.camera());
const toClient = (page, x, y) => demo(page, ([bx, by]) => window.__puzzleDemo.boardToClient(bx, by), [x, y]);

function makeInput(page, hasTouch) {
  let cdp = null;
  const session = async () => (cdp ??= await page.context().newCDPSession(page));
  const touch = async (type, points) =>
    (await session()).send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });

  // Moves through `path` ([[x, y], ...]) with the finger or mouse button down and
  // keeps holding; resolves with a function that lets go.
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

  async function drag(path, steps = 6) {
    const release = await hold(path, steps);
    await release();
  }

  // Two fingers around `centre`, from distance d0 to d1.
  async function pinch(centre, d0, d1, steps = 8) {
    const at = (d) => [
      [centre[0] - d / 2, centre[1]],
      [centre[0] + d / 2, centre[1]],
    ];
    await touch('touchStart', at(d0));
    for (let k = 1; k <= steps; k++) await touch('touchMove', at(d0 + ((d1 - d0) * k) / steps));
    await touch('touchEnd', []);
  }

  // Two fingers `gap` apart around `centre`, both moved by (dx, dy).
  async function twoFingerPan(centre, dx, dy, gap = 120, steps = 8) {
    const at = (k) => {
      const x = centre[0] + (dx * k) / steps;
      const y = centre[1] + (dy * k) / steps;
      return [
        [x - gap / 2, y],
        [x + gap / 2, y],
      ];
    };
    await touch('touchStart', at(0));
    for (let k = 1; k <= steps; k++) await touch('touchMove', at(k));
    await touch('touchEnd', []);
  }

  return { drag, hold, pinch, twoFingerPan };
}

// Frame drawn on the board canvas: luminance samples (device pixels) around board points.
async function framePixels(page) {
  return page.evaluate(() => {
    const { layout } = window.__puzzleDemo.state();
    const canvas = document.querySelector('.pz-canvas');
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    const tx = (layout.boardWidth - layout.width) / 2;
    const ty = (layout.boardHeight - layout.height) / 2;
    const device = (bx, by) => {
      const c = window.__puzzleDemo.boardToClient(bx, by);
      return [Math.round((c.x - rect.left) * k), Math.round((c.y - rect.top) * k)];
    };
    const lums = (x, y, w, h) => {
      const d = ctx.getImageData(x, y, w, h).data;
      const out = [];
      for (let i = 0; i < d.length; i += 4) out.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      return out;
    };
    const around = (bx, by, r) => {
      const [x, y] = device(bx, by);
      const v = lums(x - r, y - r, 2 * r + 1, 2 * r + 1);
      return { min: Math.min(...v), max: Math.max(...v) };
    };
    // A seam in the middle of the frame (stays on screen when zooming around the centre),
    // on the straight part of the edge left of cell (c, r).
    const c = Math.floor(layout.cols / 2);
    const r = Math.floor(layout.rows / 2);
    const seamAt = [tx + c * layout.pw, ty + (r + 0.15) * layout.ph];
    const fill = around(tx + (c + 0.5) * layout.pw, ty + (r + 0.5) * layout.ph, 3);
    const [sx, sy] = device(...seamAt);
    const row = lums(sx - 8, sy, 17, 1);
    return {
      fill,
      seam: around(...seamAt, 2),
      edge: around(tx, ty + layout.height / 2, 2),
      board: around(tx + layout.width / 2, ty / 2, 3), // the band above the frame (on screen on phones too)
      // Device pixels across the seam that are clearly darker than the frame fill.
      seamWidth: row.filter((v) => v < fill.max - 12).length,
      dpr: k,
    };
  });
}

async function boardBox(page) {
  return page.locator('.pz-canvas').boundingBox();
}

async function zoom(page, input, hasTouch, factor) {
  const box = await boardBox(page);
  const centre = [box.x + box.width / 2, box.y + box.height / 2];
  if (hasTouch) {
    const d0 = Math.min(box.width, box.height) * (factor > 1 ? 0.25 : 0.7);
    await input.pinch(centre, d0, d0 * factor);
  } else {
    await page.mouse.move(centre[0], centre[1]);
    await page.mouse.wheel(0, factor > 1 ? -400 : 400);
    await page.waitForTimeout(250);
  }
}

// Drags tray piece `index` so that its picture origin lands on (ox, oy).
async function dragFromTray(page, input, index, ox, oy) {
  const release = await holdFromTray(page, input, index, ox, oy);
  await release();
}

// The same, still holding: resolves with a function that lets go.
async function holdFromTray(page, input, index, ox, oy) {
  const { layout } = await state(page);
  const tile = page.locator(`.pz-tile[data-piece="${index}"]`);
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  const start = [box.x + box.width / 2, box.y + box.height / 2];
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  const target = await toClient(page, ox + (col + 0.5) * layout.pw, oy + (row + 0.5) * layout.ph);
  const board = await boardBox(page);
  // First move toward the board (across the tray's scroll direction), like a finger would.
  const out = board.y + board.height < box.y ? [start[0], start[1] - 40] : [start[0] - 40, start[1]];
  return input.hold([start, out, [target.x, target.y]]);
}

const framePlace = async (page) => {
  const { layout } = await state(page);
  return { layout, ox: (layout.boardWidth - layout.width) / 2, oy: (layout.boardHeight - layout.height) / 2 };
};

const preview = (page) => demo(page, () => window.__puzzleDemo.preview());

// Board canvas colour (device pixels) at a board point.
const canvasRgb = (page, bx, by) =>
  demo(
    page,
    ([x, y]) => {
      const canvas = document.querySelector('.pz-canvas');
      const rect = canvas.getBoundingClientRect();
      const k = canvas.width / rect.width;
      const c = window.__puzzleDemo.boardToClient(x, y);
      const d = canvas.getContext('2d').getImageData(Math.round((c.x - rect.left) * k), Math.round((c.y - rect.top) * k), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [bx, by],
  );

// Centre of a cluster's first piece, in client pixels.
async function pieceCentre(page, cluster) {
  const { layout } = await state(page);
  const [col, row] = cluster.pieces[0];
  return toClient(page, cluster.x + (col + 0.5) * layout.pw, cluster.y + (row + 0.5) * layout.ph);
}

async function expectNoHorizontalOverflow(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test('puzzle screen layout follows the mockup at every width', async ({ page }, testInfo) => {
  const errors = await openDemo(page);
  const viewport = page.viewportSize();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('혼자 연습');
  await expect(page.locator('.pz-count')).toHaveText('0 / 24');
  await expect(page.getByRole('heading', { name: '내 조각 24개' })).toBeVisible();
  await expect(page.locator('.pz-tile')).toHaveCount(24);
  const pictureBtn = page.getByRole('button', { name: '완성 그림 보기' });
  await expect(pictureBtn).toBeVisible();

  const board = await boardBox(page);
  const tray = await page.locator('.pz-tray').boundingBox();
  expect(board.width).toBeGreaterThan(200);
  expect(board.height).toBeGreaterThan(250);
  if (!(viewport.width > viewport.height && viewport.width >= 600)) {
    expect(tray.y).toBeGreaterThanOrEqual(board.y + board.height - 1); // tray below the board
  } else {
    expect(tray.x).toBeGreaterThanOrEqual(board.x + board.width - 1); // tray right of the board
  }

  // Touch targets: 44px or more.
  for (const target of [pictureBtn, page.locator('.pz-tile').first()]) {
    const b = await target.boundingBox();
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('play.png') });

  // Completed picture opens in a dialog and closes again.
  await pictureBtn.click();
  const dialog = page.getByRole('dialog', { name: '완성 그림' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img', { name: '완성 그림' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('play-picture.png') });
  await dialog.getByRole('button', { name: '닫기' }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test('an empty board shows the frame outlines, a bit darker at the border', async ({ page }, testInfo) => {
  await openDemo(page);
  const hasTouch = testInfo.project.use.hasTouch === true;
  const input = makeInput(page, hasTouch);
  await page.waitForTimeout(100);
  const px = await framePixels(page);
  testInfo.annotations.push({ type: 'frame pixels', description: JSON.stringify(px) });
  expect(px.fill.max).toBeGreaterThan(px.board.max); // the picture's place is lighter than the board
  expect(px.fill.max - px.seam.min).toBeGreaterThanOrEqual(25); // piece lines are visible
  expect(px.fill.max - px.seam.min).toBeLessThanOrEqual(110); // but faint
  expect(px.edge.min).toBeLessThan(px.seam.min); // the outer border is darker
  expect(px.seamWidth).toBeGreaterThanOrEqual(1);
  expect(px.seamWidth).toBeLessThanOrEqual(Math.ceil(2.5 * px.dpr));

  // Same line weight after zooming in (the frame is re-drawn for the new zoom).
  await zoom(page, input, hasTouch, 2);
  await page.waitForTimeout(400);
  const zoomed = await framePixels(page);
  expect(zoomed.fill.max - zoomed.seam.min).toBeGreaterThanOrEqual(25);
  expect(Math.abs(zoomed.seamWidth - px.seamWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('play-frame-zoomed.png') });
});

test.describe('on a high density screen', () => {
  test.use({ deviceScaleFactor: 2 });
  test('the frame lines stay thin and sharp (device pixel ratio 2)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone-390', 'one phone project is enough');
    await openDemo(page);
    await page.waitForTimeout(100);
    const px = await framePixels(page);
    testInfo.annotations.push({ type: 'frame pixels', description: JSON.stringify(px) });
    expect(px.dpr).toBe(2);
    expect(px.fill.max - px.seam.min).toBeGreaterThanOrEqual(25);
    expect(px.seamWidth).toBeGreaterThanOrEqual(2);
    expect(px.seamWidth).toBeLessThanOrEqual(5);
    await page.screenshot({ path: testInfo.outputPath('play-dpr2.png') });
  });
});

test('touch: one finger on empty board leaves it still, two fingers move and zoom it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch !== true, 'touch gestures only');
  await openDemo(page);
  const input = makeInput(page, true);
  const box = await boardBox(page);
  const centre = [box.x + box.width / 2, box.y + box.height / 2];
  const before = await camera(page);

  // Empty board (no pieces yet): one finger dragging around does nothing.
  await input.drag([centre, [centre[0] - 90, centre[1] - 70], [centre[0] + 60, centre[1] + 40]]);
  const still = await camera(page);
  // A late layout pass may re-fit by a fraction of a pixel; a pan would move it by ~60px.
  expect(still.scale).toBeCloseTo(before.scale, 3);
  expect(Math.abs(still.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(still.y - before.y)).toBeLessThanOrEqual(1);

  // Two fingers moving together pan the board.
  await input.twoFingerPan(centre, -60, -40);
  const panned = await camera(page);
  expect(panned.scale).toBeCloseTo(still.scale, 6);
  expect(panned.x).toBeCloseTo(still.x - 60, 0);
  expect(panned.y).toBeCloseTo(still.y - 40, 0);

  // Spreading them zooms in; the hint goes away.
  await zoom(page, input, true, 2);
  const zoomed = await camera(page);
  expect(zoomed.scale).toBeGreaterThan(panned.scale * 1.3);
  await expect(page.locator('.pz-hint')).toHaveClass(/is-hidden/);

  // Lifting one finger of a pinch does not turn the other into a pan.
  const at = (d) => [
    [centre[0] - d / 2, centre[1]],
    [centre[0] + d / 2, centre[1]],
  ];
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const finger = ([x, y], id) => ({ x, y, id });
  await touch('touchStart', at(100).map(finger));
  await touch('touchMove', at(140).map(finger));
  await touch('touchEnd', [finger(at(140)[1], 1)]); // finger 1 lifts, finger 0 stays
  await page.waitForTimeout(100); // pointer moves are delivered with animation frames
  const afterPinch = await camera(page);
  expect(afterPinch.scale).toBeGreaterThan(zoomed.scale);
  await touch('touchMove', [finger([at(140)[0][0] - 80, centre[1] - 60], 0)]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  expect(await camera(page)).toEqual(afterPinch);
  await expectNoHorizontalOverflow(page);
});

test('touch: the board cannot be pushed off the screen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch !== true, 'touch gestures only');
  await openDemo(page);
  const input = makeInput(page, true);
  const box = await boardBox(page);
  const centre = [box.x + box.width / 2, box.y + box.height / 2];
  for (let k = 0; k < 3; k++) await input.twoFingerPan(centre, box.width * 0.45, box.height * 0.45);
  const { layout } = await state(page);
  const corner = await toClient(page, 0, 0); // board top-left
  // At least half the view still shows board.
  expect(corner.x).toBeLessThanOrEqual(box.x + box.width / 2 + 1);
  expect(corner.y).toBeLessThanOrEqual(box.y + box.height / 2 + 1);
  const far = await toClient(page, layout.boardWidth, layout.boardHeight);
  expect(far.x).toBeGreaterThan(box.x + box.width / 2 - 1);
  expect(far.y).toBeGreaterThan(box.y + box.height / 2 - 1);
});

test('mouse: drag empty board to pan, wheel to zoom', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch === true, 'mouse only');
  await openDemo(page);
  const input = makeInput(page, false);
  const before = await camera(page);

  await zoom(page, input, false, 2);
  const zoomed = await camera(page);
  expect(zoomed.scale).toBeGreaterThan(before.scale * 1.3);
  await expect(page.locator('.pz-hint')).toHaveClass(/is-hidden/);

  const box = await boardBox(page);
  const from = [box.x + box.width / 2, box.y + box.height / 2];
  await input.drag([from, [from[0] - 80, from[1] - 60]]);
  const panned = await camera(page);
  expect(panned.scale).toBeCloseTo(zoomed.scale, 6);
  expect(panned.x).toBeLessThan(zoomed.x - 40);
  expect(panned.y).toBeLessThan(zoomed.y - 30);

  await zoom(page, input, false, 0.4);
  expect((await camera(page)).scale).toBeLessThan(panned.scale);
  await expectNoHorizontalOverflow(page);
});

test('first view: the whole frame on phones, the whole board on tablets and desktops', async ({ page }, testInfo) => {
  await openDemo(page);
  const { layout } = await state(page);
  // Spec rule 5: the board is three times the picture area, each side sqrt(3) times.
  expect(layout.boardWidth).toBe(layout.width * Math.sqrt(3));
  expect(layout.boardHeight).toBe(layout.height * Math.sqrt(3));
  const tx = (layout.boardWidth - layout.width) / 2;
  const ty = (layout.boardHeight - layout.height) / 2;
  const box = await boardBox(page);
  const contains = async (x0, y0, x1, y1) => {
    const a = await toClient(page, x0, y0);
    const b = await toClient(page, x1, y1);
    return a.x >= box.x - 0.5 && a.y >= box.y - 0.5 && b.x <= box.x + box.width + 0.5 && b.y <= box.y + box.height + 0.5;
  };
  expect(await contains(tx, ty, tx + layout.width, ty + layout.height)).toBe(true);
  if (!testInfo.project.name.startsWith('phone')) {
    expect(await contains(0, 0, layout.boardWidth, layout.boardHeight)).toBe(true);
  }
  // Frame centred in the board view (within a pixel: the view size is whole CSS pixels).
  const mid = await toClient(page, tx + layout.width / 2, ty + layout.height / 2);
  expect(Math.abs(mid.x - (box.x + box.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(mid.y - (box.y + box.height / 2))).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('play-first-view.png') });
});

test('a tablet in portrait (768 x 1024) starts with the whole board', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet-1024', 'one tablet project is enough');
  await page.setViewportSize({ width: 768, height: 1024 });
  const errors = await openDemo(page);
  const { layout } = await state(page);
  const box = await boardBox(page);
  const a = await toClient(page, 0, 0);
  const b = await toClient(page, layout.boardWidth, layout.boardHeight);
  expect(a.x).toBeGreaterThanOrEqual(box.x - 0.5);
  expect(a.y).toBeGreaterThanOrEqual(box.y - 0.5);
  expect(b.x).toBeLessThanOrEqual(box.x + box.width + 0.5);
  expect(b.y).toBeLessThanOrEqual(box.y + box.height + 0.5);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('play-768x1024.png') });
  expect(errors).toEqual([]);
});

test('two fingers on a piece zoom instead of dragging it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch !== true, 'touch gestures only');
  await openDemo(page);
  const input = makeInput(page, true);
  await page.locator('.pz-tile').first().click(); // one piece in the middle of the view
  await page.waitForTimeout(400);
  const before = await state(page);
  const [cluster] = before.clusters;
  const [col, row] = cluster.pieces[0];
  const { layout } = before;
  const centre = await toClient(page, cluster.x + (col + 0.5) * layout.pw, cluster.y + (row + 0.5) * layout.ph);
  const startScale = (await camera(page)).scale;

  await input.pinch([centre.x, centre.y], 30, 160);
  await page.waitForTimeout(300);

  expect((await camera(page)).scale).toBeGreaterThan(startScale * 1.5);
  const [after] = (await state(page)).clusters;
  expect(after.x).toBeCloseTo(cluster.x, 6);
  expect(after.y).toBeCloseTo(cluster.y, 6);
  expect(after.heldBy).toBeNull(); // released, so friends can take it
});

test('a phone on its side keeps a usable board (667 x 375)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'one phone project is enough');
  await page.setViewportSize({ width: 667, height: 375 });
  const errors = await openDemo(page);
  const board = await boardBox(page);
  const tray = await page.locator('.pz-tray').boundingBox();
  expect(tray.x).toBeGreaterThanOrEqual(board.x + board.width - 1);
  expect(board.height).toBeGreaterThanOrEqual(280);
  expect(board.width).toBeGreaterThanOrEqual(400);
  await expect(page.getByRole('button', { name: '완성 그림 보기' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('play-667x375.png') });
  expect(errors).toEqual([]);
});

test('take pieces from the tray, snap them together and complete the picture', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors = await openDemo(page);
  const hasTouch = testInfo.project.use.hasTouch === true;
  const input = makeInput(page, hasTouch);

  // Zoom out until the whole picture fits on the board view (phones start zoomed in).
  const { layout } = await state(page);
  const ox = (layout.boardWidth - layout.width) / 2;
  const oy = (layout.boardHeight - layout.height) / 2;
  for (let k = 0; k < 4; k++) {
    const board = await boardBox(page);
    const a = await toClient(page, ox, oy);
    const b = await toClient(page, ox + layout.width, oy + layout.height);
    if (a.x >= board.x && a.y >= board.y && b.x <= board.x + board.width && b.y <= board.y + board.height) break;
    await zoom(page, input, hasTouch, 0.5);
  }

  const tray = (await state(page)).tray;
  const first = tray[0];
  const neighbour = tray.find((i) => {
    const [c0, r0, c, r] = [first % 6, Math.floor(first / 6), i % 6, Math.floor(i / 6)];
    return Math.abs(c - c0) + Math.abs(r - r0) === 1;
  });

  // 1. First piece from the tray onto its place.
  await dragFromTray(page, input, first, ox, oy);
  await expect(page.locator('.pz-tile')).toHaveCount(23);
  await expect(page.getByRole('heading', { name: '내 조각 23개' })).toBeVisible();
  let s = await state(page);
  expect(s.clusters).toHaveLength(1);
  expect(s.clusters[0].x).toBeCloseTo(ox, 0);

  // 2. Its neighbour 45 units off: too far to snap (tolerance 40). The first piece sits
  //    exactly on the frame, so it is locked and already counts as placed.
  await dragFromTray(page, input, neighbour, ox + 45, oy);
  await expect(page.locator('.pz-count')).toHaveText('1 / 24');
  expect((await state(page)).clusters).toHaveLength(2);

  // 3. Drag the neighbour on the board onto its place: it snaps.
  const col = neighbour % 6;
  const row = Math.floor(neighbour / 6);
  const at = await toClient(page, ox + 45 + (col + 0.5) * layout.pw, oy + (row + 0.5) * layout.ph);
  const to = await toClient(page, ox + (col + 0.5) * layout.pw, oy + (row + 0.5) * layout.ph);
  await input.drag([[at.x, at.y], [to.x, to.y]]);
  await expect(page.locator('.pz-count')).toHaveText('2 / 24');
  s = await state(page);
  expect(s.clusters).toHaveLength(1);
  expect(s.clusters[0].pieces).toHaveLength(2);
  await page.screenshot({ path: testInfo.outputPath('play-snapped.png') });

  // 4. Every other piece from the tray.
  for (const index of tray.filter((i) => i !== first && i !== neighbour)) {
    await dragFromTray(page, input, index, ox, oy);
  }
  await expect(page.locator('.pz-count')).toHaveText('24 / 24');
  const done = page.getByRole('status').filter({ hasText: '모든 조각이 맞았어요!' });
  await expect(done).toBeVisible();
  await expect(done).toHaveCSS('opacity', '1');
  await expect(page.getByRole('heading', { name: '내 조각 0개' })).toBeVisible();
  s = await state(page);
  expect(s.clusters).toHaveLength(1);
  expect(s.progress.complete).toBe(true);
  expect(s.completedAt).not.toBeNull();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('play-complete.png') });
  expect(errors).toEqual([]);
});

test('a piece dropped near its drawn place in the frame snaps onto it and locks', async ({ page }, testInfo) => {
  const errors = await openDemo(page);
  const hasTouch = testInfo.project.use.hasTouch === true;
  const input = makeInput(page, hasTouch);
  const { layout, tray } = await state(page);
  // The drawn frame (same formula the frame pixel test samples).
  const ox = (layout.boardWidth - layout.width) / 2;
  const oy = (layout.boardHeight - layout.height) / 2;
  await dragFromTray(page, input, tray[0], ox + 20, oy - 15); // 25 units off, inside the tolerance
  await expect(page.locator('.pz-count')).toHaveText('1 / 24');
  const [cluster] = (await state(page)).clusters;
  expect(cluster.locked).toBe(true);
  expect(cluster.x).toBe(ox);
  expect(cluster.y).toBe(oy);
  expect(errors).toEqual([]);
});

test('dragging shows where a piece will snap, and it snaps right there (preview on)', async ({ page }, testInfo) => {
  const errors = await openDemo(page, { preview: 1 });
  const hasTouch = testInfo.project.use.hasTouch === true;
  const input = makeInput(page, hasTouch);
  const { layout, ox, oy } = await framePlace(page);
  const { tray } = await state(page);
  const first = tray[0];
  const [c0, r0] = [first % layout.cols, Math.floor(first / layout.cols)];

  // 1. From the tray toward its place in the frame: the place lights up before letting go.
  const release = await holdFromTray(page, input, first, ox + 22, oy - 18);
  await expect.poll(() => preview(page)).not.toBeNull(); // pointer moves arrive with animation frames
  const p1 = await preview(page);
  expect(p1).toMatchObject({ x: ox, y: oy, frameLock: true });
  const [r, g, b] = await canvasRgb(page, ox + (c0 + 0.5) * layout.pw, oy + (r0 + 0.5) * layout.ph);
  expect(g - r).toBeGreaterThan(8); // green tint on the frame cell
  expect(g).toBeGreaterThan(b);
  await page.screenshot({ path: testInfo.outputPath('play-preview-frame.png') });
  await release();
  await expect(page.locator('.pz-count')).toHaveText('1 / 24');
  let s = await state(page);
  expect(s.clusters[0]).toMatchObject({ x: ox, y: oy, locked: true });
  expect(await preview(page)).toBeNull();

  // 2. A neighbour from a free spot toward the locked piece: the touching edge lights up.
  const neighbour = tray.find((i) => {
    const [c, rr] = [i % layout.cols, Math.floor(i / layout.cols)];
    return Math.abs(c - c0) + Math.abs(rr - r0) === 1;
  });
  await page.locator(`.pz-tile[data-piece="${neighbour}"]`).click();
  await expect(page.locator('.pz-tile')).toHaveCount(22);
  await page.waitForTimeout(400); // the view may pan to show it
  s = await state(page);
  const loose = s.clusters.find((c) => !c.locked);
  const [nc, nr] = loose.pieces[0];
  const from = await pieceCentre(page, loose);
  const to = await toClient(page, ox + 25 + (nc + 0.5) * layout.pw, oy - 20 + (nr + 0.5) * layout.ph);
  const near = await toClient(page, ox + 60 + (nc + 0.5) * layout.pw, oy - 50 + (nr + 0.5) * layout.ph);
  const letGo = await input.hold([[from.x, from.y], [near.x, near.y]], 8);
  await page.waitForTimeout(100);
  expect(await preview(page)).toBeNull(); // still too far
  await letGo();
  await page.waitForTimeout(300);
  const again = await toClient(page, ox + 60 + (nc + 0.5) * layout.pw, oy - 50 + (nr + 0.5) * layout.ph);
  const letGo2 = await input.hold([[again.x, again.y], [to.x, to.y]], 8);
  await expect.poll(() => preview(page)).not.toBeNull();
  const p2 = await preview(page);
  expect(p2).toMatchObject({ x: ox, y: oy, frameLock: false });
  expect(p2.edges.length).toBeGreaterThanOrEqual(1);
  expect(p2.moving).toEqual([[nc, nr]]);
  await page.screenshot({ path: testInfo.outputPath('play-preview-edge.png') });
  await letGo2();
  await expect(page.locator('.pz-count')).toHaveText('2 / 24');
  s = await state(page);
  expect(s.clusters).toHaveLength(1);
  expect(s.clusters[0]).toMatchObject({ x: ox, y: oy, locked: true });
  expect(errors).toEqual([]);
});

test('a piece locked in the frame stays put, wiggles and says so', async ({ page }, testInfo) => {
  const errors = await openDemo(page);
  const hasTouch = testInfo.project.use.hasTouch === true;
  const input = makeInput(page, hasTouch);
  const { ox, oy } = await framePlace(page);
  await dragFromTray(page, input, (await state(page)).tray[0], ox + 5, oy + 5);
  await expect(page.locator('.pz-count')).toHaveText('1 / 24');
  await page.waitForTimeout(800); // lock flash
  const [lockedCluster] = (await state(page)).clusters;
  const at = await pieceCentre(page, lockedCluster);
  const before = await camera(page);

  // Touch: a finger trying to drag it. Mouse: a click (dragging with the mouse pans the board).
  if (hasTouch) await input.drag([[at.x, at.y], [at.x + 70, at.y + 50]]);
  else await page.mouse.click(at.x, at.y);
  const notice = page.getByRole('status').filter({ hasText: '이미 맞춘 조각이에요' });
  await expect(notice).toBeVisible();
  const [after] = (await state(page)).clusters;
  expect(after).toMatchObject({ x: ox, y: oy, locked: true, heldBy: null });
  if (!hasTouch) {
    // Dragging over it with the mouse moves the view, never the piece.
    await input.drag([[at.x, at.y], [at.x + 70, at.y + 50]]);
    expect((await state(page)).clusters[0]).toMatchObject({ x: ox, y: oy, locked: true });
  } else {
    expect(await camera(page)).toEqual(before); // one finger on a locked piece does not pan either
    // Two fingers starting on the locked piece zoom as usual.
    await input.pinch([at.x, at.y], 40, 160);
    await page.waitForTimeout(200);
    expect((await camera(page)).scale).toBeGreaterThan(before.scale * 1.5);
    expect((await state(page)).clusters[0]).toMatchObject({ x: ox, y: oy, locked: true });
  }
  await page.screenshot({ path: testInfo.outputPath('play-locked.png') });
  expect(errors).toEqual([]);
});

async function tapOutEverything(page, testInfo, pieces, shot) {
  const errors = await openDemo(page, { pieces });
  const { layout, ox, oy } = await framePlace(page);
  for (let left = pieces; left > 0; left--) {
    await page.locator('.pz-tile').first().click();
    await expect(page.locator('.pz-tile')).toHaveCount(left - 1);
  }
  await page.waitForTimeout(500);
  const { clusters, progress } = await state(page);
  expect(clusters).toHaveLength(pieces); // nothing snapped by accident
  expect(progress.placed).toBe(0);
  for (const c of clusters) {
    const [col, row] = c.pieces[0];
    const left = c.x + col * layout.pw;
    const top = c.y + row * layout.ph;
    const w = Math.max(0, Math.min(left + layout.pw, ox + layout.width) - Math.max(left, ox));
    const h = Math.max(0, Math.min(top + layout.ph, oy + layout.height) - Math.max(top, oy));
    expect((w * h) / (layout.pw * layout.ph)).toBeLessThanOrEqual(0.2 + 1e-9);
  }
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(shot) });
  expect(errors).toEqual([]);
}

test('tapping out all 24 pieces never covers the frame', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await tapOutEverything(page, testInfo, 24, 'play-all-out.png');
});

test('70 pieces: tapping out all of them never covers the frame (piles on the board edge)', async ({ page }, testInfo) => {
  test.skip(!['phone-390', 'tablet-1024'].includes(testInfo.project.name), 'one phone and one tablet');
  test.setTimeout(180_000);
  await tapOutEverything(page, testInfo, 70, 'play-70-all-out.png');
  // The whole board, zoomed out, for the board size decision.
  const input = makeInput(page, true);
  for (let k = 0; k < 3; k++) await zoom(page, input, true, 0.4);
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('play-70-all-out-whole-board.png') });
});

for (const pieces of [48, 70]) {
  test(`${pieces} pieces: first view, frame and tray`, async ({ page }, testInfo) => {
    const errors = await openDemo(page, { pieces });
    await expect(page.locator('.pz-count')).toHaveText(`0 / ${pieces}`);
    await expect(page.locator('.pz-tile')).toHaveCount(pieces);
    const { layout, ox, oy } = await framePlace(page);
    expect(layout.cols * layout.rows).toBe(pieces);
    // Frame centred, pieces big enough to touch.
    const box = await boardBox(page);
    const mid = await toClient(page, ox + layout.width / 2, oy + layout.height / 2);
    expect(Math.abs(mid.x - (box.x + box.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(mid.y - (box.y + box.height / 2))).toBeLessThanOrEqual(1);
    expect(layout.pw * (await camera(page)).scale).toBeGreaterThanOrEqual(44);
    const px = await framePixels(page);
    expect(px.fill.max - px.seam.min).toBeGreaterThanOrEqual(25);
    // Every tile gets its picture.
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('.pz-tile canvas')].every((c) => {
            const d = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data;
            return d[3] > 0;
          }),
        ),
      )
      .toBe(true);
    // A tapped piece lands next to the frame.
    await page.locator('.pz-tile').first().click();
    await expect(page.locator('.pz-tile')).toHaveCount(pieces - 1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`play-${pieces}.png`) });
    expect(errors).toEqual([]);
  });
}

test('the demo can use any built-in picture (&picture=<a portrait one>)', async ({ page }, testInfo) => {
  const errors = await openDemo(page, { picture: TALL });
  const { picture, layout } = await state(page);
  expect(picture.src).toBe(`/images/builtin/${TALL}.webp`);
  expect(layout.rows).toBeGreaterThan(layout.cols);
  // The frame (portrait) is centred and on screen.
  const { ox, oy } = await framePlace(page);
  const box = await boardBox(page);
  const mid = await toClient(page, ox + layout.width / 2, oy + layout.height / 2);
  expect(Math.abs(mid.x - (box.x + box.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(mid.y - (box.y + box.height / 2))).toBeLessThanOrEqual(1);
  await page.locator('.pz-tile').first().click();
  await expect(page.locator('.pz-tile')).toHaveCount(23);
  await expectNoHorizontalOverflow(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath('play-portrait.png') });
  expect(errors).toEqual([]);
});

for (const [key, shape] of [
  ['ssireum', 'portrait'],
  ['pluto', 'square'],
  ['chaekgado', 'wide'],
]) {
  test(`the demo opens an outside built-in picture (${key}, ${shape})`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone-390' && testInfo.project.name !== 'desktop-1440', 'two sizes are enough');
    const errors = await openDemo(page, { picture: key });
    const { picture, layout } = await state(page);
    expect(picture.src).toBe(`/images/builtin/${key}.webp`);
    expect(layout.aspect).toBeCloseTo(picture.width / picture.height, 9);
    if (shape === 'portrait') expect(layout.rows).toBeGreaterThan(layout.cols);
    else expect(layout.cols).toBeGreaterThanOrEqual(layout.rows);
    const px = await framePixels(page);
    expect(px.fill.max - px.seam.min).toBeGreaterThanOrEqual(25);
    await page.locator('.pz-tile').first().click();
    await expect(page.locator('.pz-tile')).toHaveCount(23);
    await expectNoHorizontalOverflow(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: testInfo.outputPath(`play-${key}.png`) });
    expect(errors).toEqual([]);
  });
}

test('the completed picture shows the source line of an outside picture', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390' && testInfo.project.name !== 'desktop-1440', 'two sizes are enough');
  const errors = await openDemo(page, { picture: 'starry-night' });
  await page.getByRole('button', { name: '완성 그림 보기' }).click();
  const dialog = page.getByRole('dialog', { name: '완성 그림' });
  await expect(dialog.locator('.pz-credit')).toHaveText(/^별이 빛나는 밤, 빈센트 반 고흐, 1889 — 뉴욕 현대미술관/);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('play-credit.png') });
  await dialog.getByRole('button', { name: '닫기' }).click();
  expect(errors).toEqual([]);
});

test('reduced motion: pieces and the view jump instead of sliding', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await openDemo(page);
  const hasTouch = testInfo.project.use.hasTouch === true;
  const input = makeInput(page, hasTouch);
  const animating = () => demo(page, () => window.__puzzleDemo.animating());
  const { ox, oy } = await framePlace(page);

  // A drop near the frame: already in place on the next frame, no slide.
  await dragFromTray(page, input, (await state(page)).tray[0], ox + 20, oy + 15);
  await expect(page.locator('.pz-count')).toHaveText('1 / 24');
  expect(await animating()).toEqual({ slides: 0, panning: false });

  // Tapping pieces out: no slides on any screen.
  for (let k = 0; k < 4; k++) {
    await page.locator('.pz-tile').first().click();
    expect(await animating()).toEqual({ slides: 0, panning: false });
  }
  await page.screenshot({ path: testInfo.outputPath('play-reduced-motion.png') });
  expect(errors).toEqual([]);
});

test('reduced motion: the view jumps (no pan animation) to a piece put beside the screen', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('phone'), 'the whole board is on screen here: nothing goes beside the screen');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDemo(page);
  const animating = () => demo(page, () => window.__puzzleDemo.animating());
  const start = await camera(page);
  let moved = false;
  for (let k = 0; k < 23 && !moved; k++) {
    await page.locator('.pz-tile').first().click();
    expect(await animating()).toEqual({ slides: 0, panning: false });
    const cam = await camera(page);
    moved = cam.x !== start.x || cam.y !== start.y;
  }
  expect(moved).toBe(true); // the view did move, in one jump
  // The view really shows the last piece.
  const { clusters, layout } = await state(page);
  const last = clusters.at(-1);
  const centre = await pieceCentre(page, last);
  const box = await boardBox(page);
  expect(centre.x).toBeGreaterThan(box.x);
  expect(centre.x).toBeLessThan(box.x + box.width);
  expect(centre.y).toBeGreaterThan(box.y);
  expect(centre.y).toBeLessThan(box.y + box.height);
  expect(layout.pw).toBeGreaterThan(0);
});

test('help off by default: no preview while dragging, but pieces still snap into place', async ({ page }, testInfo) => {
  const errors = await openDemo(page);
  const hasTouch = testInfo.project.use.hasTouch === true;
  const input = makeInput(page, hasTouch);
  const { layout, ox, oy } = await framePlace(page);
  const { tray, hints } = await state(page);
  expect(hints).toEqual({ preview: false, outline: true, pictureButton: true, underlay: false });
  const first = tray[0];
  const [c0, r0] = [first % layout.cols, Math.floor(first / layout.cols)];
  const release = await holdFromTray(page, input, first, ox + 22, oy - 18);
  await page.waitForTimeout(150);
  expect(await preview(page)).toBeNull();
  const [r, g] = await canvasRgb(page, ox + (c0 + 0.5) * layout.pw, oy + (r0 + 0.5) * layout.ph);
  expect(g - r).toBeLessThanOrEqual(3); // no green tint
  await release();
  await expect(page.locator('.pz-count')).toHaveText('1 / 24');
  expect((await state(page)).clusters[0]).toMatchObject({ x: ox, y: oy, locked: true });
  expect(errors).toEqual([]);
});

test('help settings change the screen: outline, picture button, underlay', async ({ page }, testInfo) => {
  // Defaults: piece outlines, picture button, plain frame.
  await openDemo(page);
  const plain = await framePixels(page);
  await expect(page.getByRole('button', { name: '완성 그림 보기' })).toHaveCount(1);
  const { layout, ox, oy } = await framePlace(page);
  // The middle of every cell: the underlay shows wherever the picture is not plain white.
  const cells = [];
  for (let r = 0; r < layout.rows; r++) for (let c = 0; c < layout.cols; c++) cells.push([ox + (c + 0.5) * layout.pw, oy + (r + 0.5) * layout.ph]);
  const plainFill = [];
  for (const at of cells) plainFill.push(await canvasRgb(page, ...at));

  // No outlines, no picture button: border only, the seam spot looks like its surroundings.
  await openDemo(page, { outline: 0, button: 0 });
  await expect(page.getByRole('button', { name: '완성 그림 보기' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(100);
  const flipped = await framePixels(page);
  expect(plain.fill.max - plain.seam.min).toBeGreaterThanOrEqual(25);
  expect(flipped.fill.max - flipped.seam.min).toBeLessThan(12);
  expect(flipped.edge.min).toBeLessThan(flipped.fill.min - 40);

  // Everything flipped, with the underlay: the picture shows faintly (colour shifts) but stays
  // light, unlike a piece.
  const errors = await openDemo(page, { outline: 0, button: 0, underlay: 1 });
  expect((await state(page)).hints).toEqual({ preview: false, outline: false, pictureButton: false, underlay: true });
  await page.waitForTimeout(100);
  const under = [];
  for (const at of cells) under.push(await canvasRgb(page, ...at));
  const shift = Math.max(...under.flatMap((rgb, k) => rgb.map((v, i) => Math.abs(v - plainFill[k][i]))));
  expect(shift).toBeGreaterThan(8);
  for (const rgb of under) expect(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]).toBeGreaterThan(185);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('play-hints-flipped.png') });
  expect(errors).toEqual([]);
});

// Which side of the frame each board piece is beside (by its cell centre).
async function sidesOfPieces(page) {
  const { layout, ox, oy } = await framePlace(page);
  return (await state(page)).clusters.map((c) => {
    const [col, row] = c.pieces[0];
    const x = c.x + (col + 0.5) * layout.pw;
    const y = c.y + (row + 0.5) * layout.ph;
    const out = { top: oy - y, right: x - (ox + layout.width), bottom: y - (oy + layout.height), left: ox - x };
    const side = Object.keys(out).reduce((a, b) => (out[b] > out[a] ? b : a));
    expect(out[side]).toBeGreaterThan(0); // outside the frame
    return side;
  });
}

// The first view may be fitted once more when the page layout settles (fonts):
// wait until the camera stays put, so later moves are the screen's own.
async function settledCamera(page) {
  let last = await camera(page);
  for (let k = 0; k < 20; k++) {
    await page.waitForTimeout(150);
    const now = await camera(page);
    if (now.x === last.x && now.y === last.y && now.scale === last.scale) return now;
    last = now;
  }
  return last;
}

const countOf = (sides) => {
  const count = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of sides) count[side] += 1;
  return count;
};

test('tapped pieces go around all four sides of the frame (whole board on screen)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('phone'), 'phones: see the next test');
  const errors = await openDemo(page);
  await settledCamera(page);
  for (let k = 0; k < 8; k++) {
    await page.locator('.pz-tile').first().click();
    await expect(page.locator('.pz-tile')).toHaveCount(23 - k);
  }
  const count = countOf(await sidesOfPieces(page));
  testInfo.annotations.push({ type: 'sides', description: JSON.stringify(count) });
  expect(count).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('play-four-sides.png') });
  expect(errors).toEqual([]);
});

test('phone: tapped pieces fill the sides in view evenly first, then the view moves on', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('phone'), 'phones only');
  const errors = await openDemo(page);
  const start = await settledCamera(page);
  let shown = 0;
  for (let k = 0; k < 16; k++) {
    await page.locator('.pz-tile').first().click();
    await expect(page.locator('.pz-tile')).toHaveCount(23 - k);
    const cam = await camera(page);
    if (Math.abs(cam.x - start.x) > 2 || Math.abs(cam.y - start.y) > 2) break;
    shown = k + 1;
  }
  // Before the view moved: only the sides above and below the frame (in view), shared evenly.
  const sides = await sidesOfPieces(page);
  const before = countOf(sides.slice(0, shown));
  testInfo.annotations.push({ type: 'sides before the view moved', description: JSON.stringify(before) });
  expect(shown).toBeGreaterThanOrEqual(4);
  expect(before.left + before.right).toBe(0);
  expect(Math.abs(before.top - before.bottom)).toBeLessThanOrEqual(1);
  // Then a spot beside the screen (any side), brought into view.
  expect(shown).toBeLessThan(16);
  const { clusters } = await state(page);
  const centre = await pieceCentre(page, clusters.at(-1));
  const box = await boardBox(page);
  expect(centre.x).toBeGreaterThan(box.x);
  expect(centre.x).toBeLessThan(box.x + box.width);
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('play-four-sides.png') });
  expect(errors).toEqual([]);
});

test('tapping a tray piece puts it on a visible free spot next to the frame', async ({ page }, testInfo) => {
  await openDemo(page);
  const [index] = (await state(page)).tray;
  await page.locator(`.pz-tile[data-piece="${index}"]`).click();
  await expect(page.locator('.pz-tile')).toHaveCount(23);
  const { clusters, layout } = await state(page);
  expect(clusters).toHaveLength(1);
  const [col, row] = clusters[0].pieces[0];
  const centre = await toClient(page, clusters[0].x + (col + 0.5) * layout.pw, clusters[0].y + (row + 0.5) * layout.ph);
  const board = await boardBox(page);
  expect(centre.x).toBeGreaterThan(board.x);
  expect(centre.x).toBeLessThan(board.x + board.width);
  expect(centre.y).toBeGreaterThan(board.y);
  expect(centre.y).toBeLessThan(board.y + board.height);

  // The first pieces stay (almost) off the frame and do not cover each other.
  for (let k = 0; k < 4; k++) await page.locator('.pz-tile').first().click();
  await expect(page.locator('.pz-tile')).toHaveCount(19);
  const after = await state(page);
  const tx = (layout.boardWidth - layout.width) / 2;
  const ty = (layout.boardHeight - layout.height) / 2;
  const cells = after.clusters.map((c) => {
    const [cc, rr] = c.pieces[0];
    return { left: c.x + cc * layout.pw, top: c.y + rr * layout.ph };
  });
  for (const { left, top } of cells) {
    const w = Math.max(0, Math.min(left + layout.pw, tx + layout.width) - Math.max(left, tx));
    const h = Math.max(0, Math.min(top + layout.ph, ty + layout.height) - Math.max(top, ty));
    expect((w * h) / (layout.pw * layout.ph)).toBeLessThanOrEqual(0.25);
  }
  for (let a = 0; a < cells.length; a++) {
    for (let b = a + 1; b < cells.length; b++) {
      expect(Math.hypot(cells[a].left - cells[b].left, cells[a].top - cells[b].top)).toBeGreaterThanOrEqual(layout.pw);
    }
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath('play-tapped.png') });
});

for (const pieces of [24, 70]) {
  test(`gestures stay smooth on a 4x slower CPU (no long tasks), ${pieces} pieces`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch !== true, 'touch gestures only');
    await openDemo(page, { pieces, preview: 1 }); // preview on: the heaviest drags
    const input = makeInput(page, true);
    // Put a few pieces on the board first so drags and pans have something to draw.
    for (let k = 0; k < 6; k++) await page.locator('.pz-tile').first().click();
    await page.waitForTimeout(500);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
      }).observe({ type: 'longtask' });
    });

    // Drags that show the magnet preview on every move: from the tray into the frame,
    // then a board piece onto its place.
    const { ox, oy } = await framePlace(page);
    await dragFromTray(page, input, (await state(page)).tray[0], ox + 20, oy + 15);
    const loose = (await state(page)).clusters.find((c) => !c.locked);
    const from = await pieceCentre(page, loose);
    const { layout: lay } = await state(page);
    const [lc, lr] = loose.pieces[0];
    const home = await toClient(page, ox + 15 + (lc + 0.5) * lay.pw, oy - 10 + (lr + 0.5) * lay.ph);
    await input.drag([[from.x, from.y], [home.x, home.y]], 30);

    const box = await boardBox(page);
    const centre = [box.x + box.width / 2, box.y + box.height / 2];
    await input.pinch(centre, 80, 220, 20);
    await input.twoFingerPan(centre, -60, 40, 120, 20);
    const { clusters, layout } = await state(page);
    const top = clusters.filter((c) => !c.locked).at(-1);
    const [col, row] = top.pieces[0];
    const at = await toClient(page, top.x + (col + 0.5) * layout.pw, top.y + (row + 0.5) * layout.ph);
    await input.drag([[at.x, at.y], [at.x + 50, at.y - 70]], 20);
    await dragFromTray(page, input, (await state(page)).tray[0], 300, 150);
    await page.waitForTimeout(800); // sprite refresh after the zoom runs in small steps
    const longTasks = await page.evaluate(() => window.__longTasks);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    testInfo.annotations.push({ type: 'long tasks (ms, 4x CPU)', description: JSON.stringify(longTasks) });
    console.log(`[${testInfo.project.name}] ${pieces} pieces: long tasks during gestures at 4x CPU:`, longTasks);
    expect(longTasks.filter((ms) => ms > 50)).toEqual([]);
  });
}
