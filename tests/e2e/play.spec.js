import { expect, test } from '@playwright/test';

// Student puzzle screen, solo demo (/play?demo=1): in-memory store, 24 pieces (6 x 4).
// Touch projects drive real touch input through CDP; the desktop project uses the mouse.

async function openDemo(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play?demo=1');
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

  // Moves through `path` ([[x, y], ...]) with the finger or mouse button down.
  async function drag(path, steps = 6) {
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
    if (hasTouch) await touch('touchEnd', []);
    else await page.mouse.up();
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

  return { drag, pinch, twoFingerPan };
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
  await input.drag([start, out, [target.x, target.y]]);
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

  // 2. Its neighbour 45 units off: too far to snap (tolerance 30).
  await dragFromTray(page, input, neighbour, ox + 45, oy);
  await expect(page.locator('.pz-count')).toHaveText('0 / 24');
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

test('gestures stay smooth on a 4x slower CPU (no long tasks)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch !== true, 'touch gestures only');
  await openDemo(page);
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

  const box = await boardBox(page);
  const centre = [box.x + box.width / 2, box.y + box.height / 2];
  await input.pinch(centre, 80, 220, 20);
  await input.twoFingerPan(centre, -60, 40, 120, 20);
  const { clusters, layout } = await state(page);
  const top = clusters.at(-1);
  const [col, row] = top.pieces[0];
  const at = await toClient(page, top.x + (col + 0.5) * layout.pw, top.y + (row + 0.5) * layout.ph);
  await input.drag([[at.x, at.y], [at.x + 50, at.y - 70]], 20);
  await dragFromTray(page, input, (await state(page)).tray[0], 300, 150);
  await page.waitForTimeout(800); // sprite refresh after the zoom runs in small steps
  const longTasks = await page.evaluate(() => window.__longTasks);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  testInfo.annotations.push({ type: 'long tasks (ms, 4x CPU)', description: JSON.stringify(longTasks) });
  console.log(`[${testInfo.project.name}] long tasks during gestures at 4x CPU:`, longTasks);
  expect(longTasks.filter((ms) => ms > 50)).toEqual([]);
});
