import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { EXACT_3_2, WIDE } from './support/pictures.js';
import {
  boardBox,
  cellPoint,
  dragFromTray as dragTrayPiece,
  expectNoHorizontalOverflow,
  frameOrigin,
  puzzleState,
  showFrame as showPuzzleFrame,
} from './support/puzzle.js';
import { cspViolations, joinStudent, startInOneGroup, supabaseHosts } from './support/student.js';
import { classControl, cleanUpClasses, closeSql, deleteImages, openClass, storeImage } from './support/teacher.js';
import { storageAdmin } from './support/storage.js';

// T11 → T22: one group plays the same puzzle on several devices against the local rt server
// (D5~D10). Every student is its own browser context; the teacher runs from Node and follows
// the server's side (who holds what) through its overview. The hold-still release (10 s) runs
// in real time; the one-minute rule moves the server clock: disconnect.spec.js.

const createdImages = [];

test.afterAll(async () => {
  await cleanUpClasses();
  await deleteImages(createdImages.splice(0), storageAdmin().storage);
  await closeSql();
});

// ---------- class set-up ----------

async function createClass(pieces, { key = WIDE, groups = 2, imageId = null, hints } = {}) {
  const cls = await openClass({ pieces, groups, builtinKey: key, imageId, hints });
  return { ...cls, control: await classControl(cls) };
}

// ---------- reading the screen (moves: support/puzzle.js) ----------

const state = puzzleState;
const indexOf = ([col, row], cols) => row * cols + col;
const clusterOf = (s, index) => s.clusters.find((c) => c.pieces.some((cell) => indexOf(cell, s.layout.cols) === index));
const showFrame = (student) => showPuzzleFrame(student.page, student.input);
const dragFromTray = (student, index, ox, oy) => dragTrayPiece(student.page, student.input, index, ox, oy);

// Presses on a board cluster (its first piece), moves a little and keeps holding.
async function pressCluster(student, cluster, move = [14, 10]) {
  const at = await cellPoint(student.page, cluster.x, cluster.y, cluster.pieces[0]);
  return student.input.hold([
    [at.x, at.y],
    [at.x + move[0], at.y + move[1]],
  ]);
}

// A pixel move that takes a cluster further from its place in the frame, so it never locks.
async function awayFromFrame(page, cluster, px) {
  const { ox, oy } = await frameOrigin(page);
  const sx = cluster.x - ox >= 0 ? 1 : -1;
  const sy = cluster.y - oy >= 0 ? 1 : -1;
  return [sx * px, sy * px * 0.6];
}

// The cluster as the server has it (teacher overview, at most a second late).
const serverCluster = (cls, id, group = 1) => cls.control.cluster(group, id);
const holderOf = (cls, id) => serverCluster(cls, id)?.heldBy ?? null;

const sorted = (list) => [...list].sort((a, b) => a - b);

// ---------- tests ----------

const COLORS = ['#F0544F', '#22A559', '#3B82F6', '#9B51E0', '#F2A20C', '#E64C9A'];
const trayOf = async (student) => sorted((await state(student.page)).tray);

test('D5~D10: a group of four plays one puzzle together to the end', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const cls = await createClass(12); // 4 x 3: three pieces each
  const students = [];
  for (const name of ['민준', '서연', '지호', '유나']) students.push(await joinStudent(browser, testInfo, cls, name));
  const [A, B, C, D] = students;
  await startInOneGroup(cls.control, students);
  for (const s of students) s.memberId = await cls.control.memberId(s.name);

  // D5: 12 pieces dealt 3 / 3 / 3 / 3, each screen shows only its own tray.
  const dealt = {};
  for (const s of students) {
    dealt[s.memberId] = await trayOf(s);
    await expect(s.page.locator('.pz-tile')).toHaveCount(3);
    await expect(s.page.getByRole('heading', { level: 1 })).toHaveText('1모둠');
  }
  expect(sorted(Object.values(dealt).flat())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // Groupmates with their names and colours, me marked.
  for (const s of students) {
    for (const other of students) await expect(s.page.locator('.pz-chips .chip', { hasText: other.name })).toBeVisible();
    await expect(s.page.locator('.pz-chips .chip', { hasText: s.name }).locator('em')).toHaveText('나');
  }
  // Someone else's piece is not in my tray (the server refuses it too: socket.test.js D12).
  const notMine = dealt[B.memberId][0];
  expect(await A.page.evaluate((piece) => window.__puzzle.state().tray.includes(piece), notMine)).toBe(false);
  for (const s of students) await showFrame(s);
  await A.page.screenshot({ path: testInfo.outputPath('coop-1-start.png') });

  // A takes a piece (tap): it appears on every screen.
  const first = (await state(A.page)).tray[0];
  await A.page.locator(`.pz-tile[data-piece="${first}"]`).click();
  await expect(A.page.locator('.pz-tile')).toHaveCount(2);
  for (const s of students) await expect.poll(async () => clusterOf(await state(s.page), first)?.id ?? null).not.toBeNull();
  const placed = clusterOf(await state(B.page), first);
  await expect.poll(() => serverCluster(cls, placed.id)?.x ?? null).toBe(placed.x);

  // D6: B and C grab it at the same time: only one gets it, the others see that one's colour.
  const [releaseB, releaseC] = await Promise.all([pressCluster(B, placed), pressCluster(C, placed, [-14, 10])]);
  await expect.poll(() => holderOf(cls, placed.id)).not.toBeNull();
  const holder = holderOf(cls, placed.id);
  expect([B.memberId, C.memberId]).toContain(holder);
  const [winner, loser, releaseWinner, releaseLoser] = holder === B.memberId ? [B, C, releaseB, releaseC] : [C, B, releaseC, releaseB];
  await expect(loser.page.getByRole('status').filter({ hasText: '친구가 잡고 있는 조각이에요.' })).toBeVisible();
  expect(await loser.page.evaluate(() => window.__puzzle.dragging())).toBeNull();
  expect(await winner.page.evaluate(() => window.__puzzle.dragging())).toBe(placed.id);
  const winnerColor = (await state(A.page)).members.find((m) => m.uid === winner.memberId).color;
  for (const s of [A, D, loser]) {
    await expect.poll(() => s.page.evaluate(() => window.__puzzle.holders())).toEqual([{ id: placed.id, color: COLORS[winnerColor], name: winner.name }]);
  }
  await A.page.screenshot({ path: testInfo.outputPath('coop-2-friend-holds.png') });
  await releaseLoser();

  // The winner lets go a bit further: every screen slides it to the same place (D7, rule 3).
  await releaseWinner();
  await expect.poll(() => holderOf(cls, placed.id)).toBeNull();
  const moved = serverCluster(cls, placed.id);
  for (const s of students) {
    await expect.poll(async () => clusterOf(await state(s.page), first)).toMatchObject({ id: placed.id, x: moved.x, y: moved.y, heldBy: null });
    await expect.poll(() => s.page.evaluate(() => window.__puzzle.holders())).toEqual([]);
  }

  // D7: a neighbour dropped close by snaps on, on every screen, and then they move together.
  // First A puts the piece over the middle of the frame (on another piece's place, so it does
  // not lock): its neighbours' places are then on screen everywhere.
  const { layout, ox: fx, oy: fy } = await frameOrigin(A.page);
  const [col, row] = [first % layout.cols, Math.floor(first / layout.cols)];
  const spotCol = col === 1 ? 2 : 1;
  const spot = { x: fx + (spotCol - col) * layout.pw, y: fy + (1 - row) * layout.ph };
  {
    const from = await cellPoint(A.page, moved.x, moved.y, [col, row]);
    const to = await cellPoint(A.page, spot.x, spot.y, [col, row]);
    await A.input.drag([[from.x, from.y], [to.x, to.y]]);
  }
  await expect.poll(() => Math.abs((serverCluster(cls, placed.id)?.x ?? Infinity) - spot.x) < 5).toBe(true);
  const neighbours = [
    [col + 1, row],
    [col - 1, row],
    [col, row + 1],
    [col, row - 1],
  ]
    .filter(([cc, rr]) => cc >= 0 && rr >= 0 && cc < layout.cols && rr < layout.rows)
    .map((cell) => indexOf(cell, layout.cols));
  const traysNow = Object.fromEntries(await Promise.all(students.map(async (s) => [s.memberId, await trayOf(s)])));
  // D keeps its tray for the checks below when someone else can give.
  const canGive = (s) => traysNow[s.memberId].some((p) => neighbours.includes(p));
  const giver = [A, B, C].find(canGive) ?? D;
  const neighbour = traysNow[giver.memberId].find((p) => neighbours.includes(p));
  await dragFromTray(giver, neighbour, spot.x + 12, spot.y - 9);
  for (const s of students) {
    await expect
      .poll(async () => {
        const st = await state(s.page);
        const both = clusterOf(st, first);
        return both && both === clusterOf(st, neighbour) ? both.pieces.length : 0;
      })
      .toBe(2);
  }
  // Same size: the cluster with the smaller id stays put and the other joins it (snap.js rule 4).
  const merged = clusterOf(await state(A.page), first);
  await expect.poll(() => serverCluster(cls, merged.id)?.pieces.length).toBe(2);
  expect(serverCluster(cls, merged.id)).toMatchObject({ x: merged.x, y: merged.y });
  expect(Math.hypot(merged.x - spot.x, merged.y - spot.y)).toBeLessThan(20);
  const mover = students.find((s) => s !== giver && s !== D);
  const releaseMove = await pressCluster(mover, merged, await awayFromFrame(mover.page, merged, 60));
  await releaseMove();
  await expect.poll(() => serverCluster(cls, merged.id).x).not.toBe(merged.x);
  await expect.poll(() => holderOf(cls, merged.id)).toBeNull();
  const afterMove = serverCluster(cls, merged.id);
  for (const s of students) {
    await expect
      .poll(async () => {
        const st = await state(s.page);
        const one = clusterOf(st, first);
        return one === clusterOf(st, neighbour) ? { x: one.x, y: one.y, n: one.pieces.length } : null;
      })
      .toEqual({ x: afterMove.x, y: afterMove.y, n: 2 });
  }
  await B.page.screenshot({ path: testInfo.outputPath('coop-3-merged.png') });

  // D8: held still for 10 s, the piece is let go by itself, and a friend can take it.
  const still = clusterOf(await state(A.page), first);
  const releaseStill = await pressCluster(A, still, [6, 4]);
  const grabbedAt = Date.now(); // the last move of the finger
  await expect.poll(() => holderOf(cls, still.id)).toBe(A.memberId);
  await expect.poll(() => A.page.evaluate(() => window.__puzzle.dragging()), { timeout: 15000 }).toBeNull();
  const heldFor = Date.now() - grabbedAt;
  expect(heldFor).toBeGreaterThan(9000);
  await expect.poll(() => holderOf(cls, still.id)).toBeNull();
  await releaseStill(); // the finger is lifted later: nothing more happens
  const stillNow = clusterOf(await state(B.page), first);
  const releaseTake = await pressCluster(B, stillNow, await awayFromFrame(B.page, stillNow, 20));
  await expect.poll(() => holderOf(cls, still.id)).toBe(B.memberId);
  await releaseTake();
  await expect.poll(() => holderOf(cls, still.id)).toBeNull();
  testInfo.annotations.push({ type: 'hold-still release after (ms)', description: String(heldFor) });

  // D8: D holds a piece and the page goes away: the server lets go at once, friends see D away
  // and C takes it.
  await showFrame(D);
  const held = clusterOf(await state(D.page), first);
  await pressCluster(D, held, await awayFromFrame(D.page, held, 10));
  await expect.poll(() => holderOf(cls, held.id)).toBe(D.memberId);
  const trayBefore = await trayOf(D);
  await D.page.close();
  for (const s of [A, B, C]) {
    await expect(s.page.locator('.pz-chips .chip', { hasText: D.name }).locator('em')).toHaveText('잠시 나감', { timeout: 15000 });
  }
  await expect.poll(() => holderOf(cls, held.id)).toBeNull();
  await expect.poll(() => A.page.evaluate(() => window.__puzzle.holders())).toEqual([]);
  const heldNow = clusterOf(await state(C.page), first);
  const releaseC2 = await pressCluster(C, heldNow, await awayFromFrame(C.page, heldNow, 20));
  await expect.poll(() => holderOf(cls, held.id)).toBe(C.memberId);
  await releaseC2();
  await expect.poll(() => holderOf(cls, held.id)).toBeNull();
  await A.page.screenshot({ path: testInfo.outputPath('coop-4-friend-away.png') });

  // D9: the same device comes back within the minute (/play in a new tab): the same tray.
  await D.newPage();
  await D.page.goto('/play');
  await expect(D.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  expect(await trayOf(D)).toEqual(trayBefore);
  for (const s of [A, B, C]) {
    await expect(s.page.locator('.pz-chips .chip', { hasText: D.name }).locator('em')).toHaveCount(0);
  }
  await expectNoHorizontalOverflow(A.page);

  // D10: everyone puts the rest into the frame; the last piece shows the celebration to all.
  for (const s of students) {
    await showFrame(s);
    const { ox, oy } = await frameOrigin(s.page);
    for (const piece of (await state(s.page)).tray) await dragFromTray(s, piece, ox, oy);
  }
  const { ox, oy } = await frameOrigin(A.page);
  // Every piece is on A's board (the last drops of the others have arrived), then A puts the
  // loose ones into the frame.
  await expect.poll(async () => (await state(A.page)).clusters.reduce((n, cl) => n + cl.pieces.length, 0)).toBe(12);
  for (let round = 0; round < 3 && !(await state(A.page)).progress.complete; round++) {
    for (const loose of (await state(A.page)).clusters.filter((cl) => !cl.locked)) {
      const from = await cellPoint(A.page, loose.x, loose.y, loose.pieces[0]);
      const to = await cellPoint(A.page, ox, oy, loose.pieces[0]);
      await A.input.drag([[from.x, from.y], [to.x, to.y]]);
    }
    await A.page.waitForTimeout(500);
  }
  for (const s of students) {
    await expect(s.page.getByRole('heading', { level: 1, name: '1모둠 완성!' })).toBeVisible({ timeout: 15000 });
    await expect(s.page.getByText('모든 조각이 맞았어요')).toBeVisible();
    await expect(s.page.locator('.st-stats')).toContainText('12개');
    await expect(s.page.locator('.st-stats')).toContainText(/\d+초|\d+분/);
    await expect(s.page.locator('.st-done .sub')).toContainText('함께 맞췄어요');
    await expect(s.page.locator('.st-done .sub')).toContainText(s.name);
    await expect(s.page.locator('.st-done-img img')).toHaveJSProperty('complete', true);
    await expectNoHorizontalOverflow(s.page);
  }
  // No ranks: nothing about other groups. The teacher's overview has it complete.
  await expect(A.page.locator('main')).not.toContainText('등');
  await expect.poll(() => cls.control.group(1)?.completedAt ?? null).not.toBeNull();
  await A.page.waitForTimeout(1500); // confetti and heading settle
  await A.page.screenshot({ path: testInfo.outputPath('coop-5-complete.png'), fullPage: true });

  // The class ends: the celebration gives way to the ended message.
  await cls.control.end();
  await expect(B.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible();

  for (const s of students) {
    expect(s.errors).toEqual([]);
    expect(await cspViolations(s.page)).toEqual([]);
    expect(supabaseHosts(s.hosts)).toEqual([]);
    await s.context.close();
  }
});

test("the teacher's own picture (private bucket, signed URL) and the class's help settings reach the puzzle", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough');
  test.setTimeout(90_000);
  const image = await storeImage(readFileSync(new URL(`../../public/images/builtin/${EXACT_3_2}.webp`, import.meta.url)));
  createdImages.push(image.id);
  const cls = await createClass(12, {
    groups: 1,
    imageId: image.id,
    hints: { preview: true, outline: false, pictureButton: false, underlay: true },
  });
  const s = await joinStudent(browser, testInfo, cls, '나린');
  await startInOneGroup(cls.control, [s]);
  const st = await state(s.page);
  expect(st.hints).toEqual({ preview: true, outline: false, pictureButton: false, underlay: true });
  expect(st.picture).toMatchObject({ width: 1800, height: 1200 });
  expect(st.picture.src).toMatch(/^blob:/);
  await expect(s.page.getByRole('button', { name: '완성 그림 보기' })).toHaveCount(0);
  await s.page.screenshot({ path: testInfo.outputPath('coop-teacher-picture.png') });
  expect(await cspViolations(s.page)).toEqual([]);
  // The picture itself comes from Storage through the signed URL; nothing else from Supabase.
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('a class that ended while the device was away: reopening says so and forgets it', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough');
  test.setTimeout(90_000);
  const cls = await createClass(12);
  const s = await joinStudent(browser, testInfo, cls, '태오');
  await startInOneGroup(cls.control, [s]);
  await s.page.close();
  await cls.control.end();
  await s.newPage();
  await s.page.goto('/play');
  await expect(s.page.getByRole('heading', { level: 1, name: '이 수업은 끝났어요' })).toBeVisible({ timeout: 15000 });
  expect(await s.page.evaluate((code) => localStorage.getItem(`jigsaw-student:${code}`), cls.code)).toBeNull();
  expect(await s.page.evaluate(() => window.__puzzle)).toBeUndefined();
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('leaving the page while holding a piece lets it go; coming back asks for a fresh state', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet-1024', 'one size is enough');
  test.setTimeout(90_000);
  const cls = await createClass(12);
  const s = await joinStudent(browser, testInfo, cls, '라온');
  const { sent } = s;
  await startInOneGroup(cls.control, [s]);
  const memberId = await cls.control.memberId('라온');
  const piece = (await state(s.page)).tray[0];
  await s.page.locator(`.pz-tile[data-piece="${piece}"]`).click();
  await expect.poll(async () => clusterOf(await state(s.page), piece)?.heldBy).toBeNull();
  const cl = clusterOf(await state(s.page), piece);
  const release = await pressCluster(s, cl, [30, 20]);
  await expect.poll(() => holderOf(cls, cl.id)).toBe(memberId);
  const setVisibility = (value) =>
    s.page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
  await setVisibility('hidden');
  await expect.poll(() => s.page.evaluate(() => window.__puzzle.dragging())).toBeNull();
  await expect.poll(() => holderOf(cls, cl.id)).toBeNull();
  await expect.poll(() => sent.some((f) => f.includes('"release"'))).toBe(true);
  await release();
  await setVisibility('visible');
  await expect.poll(() => sent.some((f) => f.includes('"sync"'))).toBe(true);
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('a student added after the start has no tray and plays with the board', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet-1024', 'one size is enough');
  test.setTimeout(90_000);
  const cls = await createClass(12);
  const first = await joinStudent(browser, testInfo, cls, '하은');
  await startInOneGroup(cls.control, [first]);
  const late = await joinStudent(browser, testInfo, cls, '도윤');
  await expect(late.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  await cls.control.assign(await cls.control.memberId('도윤'), 1);
  await expect(late.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  await expect(late.page.locator('.pz-tile')).toHaveCount(0);
  await expect(late.page.getByText('상자가 비었어요. 판 위 조각을 함께 맞춰요')).toBeVisible();
  // A piece the first student puts out shows up and the late student can move it.
  const piece = (await state(first.page)).tray[0];
  await first.page.locator(`.pz-tile[data-piece="${piece}"]`).click();
  await expect.poll(async () => clusterOf(await state(late.page), piece)?.id ?? null).not.toBeNull();
  await expect.poll(async () => clusterOf(await state(late.page), piece)?.heldBy ?? null).toBeNull();
  const cl = clusterOf(await state(late.page), piece);
  await (await pressCluster(late, cl, [40, 30]))();
  await expect.poll(() => serverCluster(cls, cl.id)?.x ?? cl.x).not.toBe(cl.x);
  await late.page.screenshot({ path: testInfo.outputPath('coop-late-joiner.png') });
  for (const s of [first, late]) {
    expect(s.errors).toEqual([]);
    await s.context.close();
  }
});

test('moving a student to another group switches the puzzle and its group', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough');
  test.setTimeout(90_000);
  const cls = await createClass(12);
  const [s1, s2] = [await joinStudent(browser, testInfo, cls, '가람'), await joinStudent(browser, testInfo, cls, '나래')];
  await startInOneGroup(cls.control, [s1, s2]);
  await cls.control.assign(await cls.control.memberId('나래'), 2);
  await expect(s2.page.getByRole('heading', { level: 1 })).toHaveText('2모둠', { timeout: 15000 });
  await expect(s2.page.locator('main[data-ready="true"]')).toBeVisible();
  // The new group has all 12 pieces for its only student; the old group's tray went to s1.
  await expect(s2.page.locator('.pz-tile')).toHaveCount(12);
  await expect(s1.page.locator('.pz-tile')).toHaveCount(12);
  await expect(s1.page.locator('.pz-chips .chip')).toHaveCount(1);
  // s2 hears its new group only: a piece taken in group 1 does not show up there.
  const piece = (await state(s1.page)).tray[0];
  await s1.page.locator(`.pz-tile[data-piece="${piece}"]`).click();
  await expect.poll(async () => (await state(s1.page)).clusters.length).toBe(1);
  await s2.page.waitForTimeout(1000);
  expect((await state(s2.page)).clusters).toEqual([]);
  for (const s of [s1, s2]) {
    expect(s.errors).toEqual([]);
    await s.context.close();
  }
});

test('completion with reduced motion: no confetti or pop animation', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'one size is enough');
  test.setTimeout(90_000);
  const cls = await createClass(12);
  const s = await joinStudent(browser, testInfo, cls, '소율', { reducedMotion: 'reduce' });
  await startInOneGroup(cls.control, [s]);
  await showFrame(s);
  const { ox, oy } = await frameOrigin(s.page);
  for (const piece of (await state(s.page)).tray) await dragFromTray(s, piece, ox, oy);
  await expect(s.page.getByRole('heading', { level: 1, name: '1모둠 완성!' })).toBeVisible({ timeout: 15000 });
  const animations = await s.page.evaluate(() =>
    [...document.querySelectorAll('.st-confetti i, .st-done h1')].map((el) => getComputedStyle(el).animationName),
  );
  expect(new Set(animations)).toEqual(new Set(['none']));
  await expect(s.page.locator('.st-done .sub')).toHaveText('모둠 친구들과 함께 맞췄어요');
  await s.page.screenshot({ path: testInfo.outputPath('coop-complete-reduced.png') });
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('an outside picture shows its credit, on the puzzle and when it is complete', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'one size is enough');
  test.setTimeout(120_000);
  const index = JSON.parse(readFileSync(new URL('../../public/images/builtin/index.json', import.meta.url), 'utf8'));
  const art = index.images.find((image) => image.key === 'starry-night');
  const cls = await createClass(12, { key: art.key });
  const s = await joinStudent(browser, testInfo, cls, '서아');
  await startInOneGroup(cls.control, [s]);
  expect((await state(s.page)).picture.credit).toBe(art.credit);

  // '완성 그림 보기' shows the picture with its source line.
  await s.page.getByRole('button', { name: '완성 그림 보기' }).click();
  const dialog = s.page.getByRole('dialog', { name: '완성 그림' });
  await expect(dialog.locator('.pz-credit')).toHaveText(art.credit);
  await s.page.screenshot({ path: testInfo.outputPath('coop-credit-dialog.png') });
  await dialog.getByRole('button', { name: '닫기' }).click();

  await showFrame(s);
  const { ox, oy } = await frameOrigin(s.page);
  for (const piece of (await state(s.page)).tray) await dragFromTray(s, piece, ox, oy);
  await expect(s.page.getByRole('heading', { level: 1, name: '1모둠 완성!' })).toBeVisible({ timeout: 15000 });
  await expect(s.page.locator('.st-credit')).toHaveText(art.credit);
  await s.page.waitForTimeout(1200);
  await s.page.screenshot({ path: testInfo.outputPath('coop-credit-complete.png'), fullPage: true });
  expect(s.errors).toEqual([]);
  expect(await cspViolations(s.page)).toEqual([]);
  await s.context.close();
});

test('the reconnecting band shows over the puzzle while the rt server cannot be reached', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const cls = await createClass(12);
  const s = await joinStudent(browser, testInfo, cls, '다인');
  await startInOneGroup(cls.control, [s]);
  const band = s.page.getByRole('status').filter({ hasText: '연결이 끊겼어요. 다시 연결하는 중이에요…' });
  await expect(band).toBeHidden();
  await s.context.setOffline(true);
  await s.page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(band).toBeVisible({ timeout: 20000 });
  await expectNoHorizontalOverflow(s.page);
  await s.page.screenshot({ path: testInfo.outputPath('coop-reconnecting.png') });
  await s.context.setOffline(false);
  await expect(band).toBeHidden({ timeout: 20000 });
  await expect(s.page.locator('.pz-tile')).toHaveCount(12);
  expect(s.errors).toEqual([]);
  await s.context.close();
});

for (const pieces of [24, 70]) {
  test(`class puzzle stays smooth on a 4x slower CPU (no long tasks), ${pieces} pieces`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch !== true, 'touch gestures only');
    test.setTimeout(120_000);
    const cls = await createClass(pieces);
    const [s, friend] = [await joinStudent(browser, testInfo, cls, '예린'), await joinStudent(browser, testInfo, cls, '시우')];
    await startInOneGroup(cls.control, [s, friend]);
    for (const [st, n] of [
      [s, 6],
      [friend, 4],
    ]) {
      for (const piece of (await state(st.page)).tray.slice(0, n)) await st.page.locator(`.pz-tile[data-piece="${piece}"]`).click();
    }
    await expect.poll(async () => (await state(s.page)).clusters.length).toBe(10);
    await s.page.waitForTimeout(500);

    const cdp = await s.context.newCDPSession(s.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await s.page.evaluate(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
      }).observe({ type: 'longtask' });
    });
    const { ox, oy } = await frameOrigin(s.page);
    await dragFromTray(s, (await state(s.page)).tray[0], ox + 20, oy + 15);
    const box = await boardBox(s.page);
    const centre = [box.x + box.width / 2, box.y + box.height / 2];
    await s.input.pinch(centre, 80, 220, 20);
    // A friend moves pieces meanwhile: events arrive and pieces slide on this screen.
    for (const cl of (await state(friend.page)).clusters.filter((c) => !c.locked).slice(0, 3)) {
      const release = await pressCluster(friend, cl, [30, 20]);
      await release();
    }
    const top = (await state(s.page)).clusters.filter((c) => !c.locked).at(-1);
    const at = await cellPoint(s.page, top.x, top.y, top.pieces[0]);
    await s.input.drag([[at.x, at.y], [at.x + 50, at.y - 70]], 20);
    await s.page.waitForTimeout(1200);
    const longTasks = await s.page.evaluate(() => window.__longTasks);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    testInfo.annotations.push({ type: 'long tasks (ms, 4x CPU)', description: JSON.stringify(longTasks) });
    console.log(`[${testInfo.project.name}] class ${pieces} pieces: long tasks at 4x CPU:`, longTasks);
    expect(longTasks.filter((ms) => ms > 50)).toEqual([]);
    for (const st of [s, friend]) {
      expect(st.errors).toEqual([]);
      await st.context.close();
    }
  });
}
