import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { storageAdmin } from './support/storage.js';
import { classControl, cleanUpClasses, closeSql, deleteImages, nodeStudent, openClass, signInPage, sql, storeImage } from './support/teacher.js';
import { expectNoHorizontalOverflow } from './support/puzzle.js';

// T12, T21: 모둠 한눈에 보기 and 수업 끝내기 (D10, D11, D14) against the local rt server. The
// teacher is a browser; the students are Node socket.io clients that join, take pieces from
// their trays and put them down (the student screens move to the rt server in T22).

const createdImages = [];

test.afterAll(async () => {
  await cleanUpClasses();
  await deleteImages(createdImages.splice(0), storageAdmin().storage);
  await closeSql();
});

function watch(page, label, testInfo) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && testInfo.annotations.push({ type: `console (${label})`, description: m.text() }));
  return errors;
}

async function watchCsp(context) {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}
const violations = (page) => page.evaluate(() => window.__cspViolations);

async function openTeacher(browser, testInfo, sessionId, viewport) {
  const context = await browser.newContext({ ...testInfo.project.use, ...(viewport ? { viewport, isMobile: false, hasTouch: false } : {}) });
  await watchCsp(context);
  await signInPage(context);
  const page = await context.newPage();
  const errors = watch(page, 'teacher', testInfo);
  await page.goto(`/teacher/sessions/${sessionId}`);
  return { context, page, errors };
}

const card = (page, number) => page.locator('.t-ov-card', { has: page.getByRole('heading', { level: 2, name: `${number}모둠`, exact: true }) });
const progress = (page, number) => card(page, number).getByRole('progressbar');
// Every small board has drawn its pieces (sprites ready, canvas not blank).
async function boardsDrawn(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.t-ov-card:not(.is-empty) canvas')].every((c) => {
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 0) return true;
      return false;
    }),
  );
}

// The finished picture leaves room for the badge: the canvas is empty under the badge.
async function badgeCoversNothing(page, cardLocator) {
  return cardLocator.evaluate((el) => {
    const canvas = el.querySelector('canvas');
    const badge = el.querySelector('.t-ov-badge').getBoundingClientRect();
    const box = canvas.getBoundingClientRect();
    const k = canvas.width / box.width;
    const x = Math.floor((badge.left - box.left) * k);
    const y = Math.floor((badge.top - box.top) * k);
    const data = canvas.getContext('2d').getImageData(x, y, Math.ceil(badge.width * k), Math.ceil(badge.height * k)).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return false;
    return true;
  });
}

// Puts `locked` pieces of a group into the frame and `loose` ones around it, from the trays of
// the group's students in turn.
async function playGroup(students, { locked = 0, loose = 0, seed = 1 }) {
  let todoLocked = locked;
  let todoLoose = loose;
  for (let round = 0; todoLocked + todoLoose > 0 && round < 100; round++) {
    const s = students[round % students.length];
    if (!s.socket || s.tray.length === 0) continue;
    if (todoLocked > 0) todoLocked -= (await s.place({ locked: 1, seed: seed + round })).length;
    else todoLoose -= (await s.place({ loose: 1, seed: seed + round })).length;
  }
}

// The teacher's websocket messages of one kind (socket.io frames '42["overview",…]').
function countFrames(page, event) {
  const seen = [];
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => typeof payload === 'string' && payload.startsWith(`42["${event}"`) && seen.push(Date.now())));
  return seen;
}

// ---------- the class from start to end ----------

test('D10·D11·D14: the server pushes progress (no polling), 완성, big view, late student, then 수업 끝내기 cleans up', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const cls = await openClass({ pieces: 12, groups: 2 });
  const A = await nodeStudent(cls.code, '민준');
  const B = await nodeStudent(cls.code, '서연');
  const C = await nodeStudent(cls.code, '지호');
  const control = await classControl(cls);
  await control.assign(A.memberId, 1);
  await control.assign(B.memberId, 1);
  await control.assign(C.memberId, 2);
  control.close();

  // The lobby turns into the overview when the teacher starts.
  const teacher = await openTeacher(browser, testInfo, cls.id);
  const { page } = teacher;
  const apiCalls = [];
  page.on('request', (r) => r.url().includes(':3400/api/') && apiCalls.push(r.url()));
  await expect(page.locator('.t-group .t-chip', { hasText: '지호' })).toBeVisible();
  await page.getByRole('button', { name: '시작하기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /모둠 한눈에 보기/ })).toBeAttached();
  await expect(page.locator('.t-ov-card')).toHaveCount(2);
  await expect(page).toHaveTitle(/모둠 한눈에 보기/);
  for (const s of [A, B, C]) await s.ready();
  await expect(progress(page, 1)).toHaveAttribute('aria-valuetext', '12조각 중 0조각 (0%)');
  for (const [s, n] of [
    [A, 1],
    [B, 1],
    [C, 2],
  ]) {
    await expect(card(page, n).locator('.t-ov-mates .chip', { hasText: s.name })).toBeVisible();
  }
  await expect(card(page, 1).locator('.chip.off')).toHaveCount(0);
  await expect(page.locator('.t-ov-clock')).toHaveText(/^\d+:\d\d$/);
  await expect(page.locator('.t-ov-hints')).toHaveText('도움: 조각 윤곽선 · 완성 그림 버튼');
  await expect(page.locator('.t-ov-note')).toContainText('바뀌면 바로 보여요');
  await expect.poll(() => boardsDrawn(page)).toBe(true);
  await expectNoHorizontalOverflow(page);

  // No polling: nothing is asked while nothing changes (spec D11: the server pushes).
  const before = await page.locator('.t-ov-card canvas').first().evaluate((c) => c.toDataURL());
  const callsAtStart = apiCalls.length;
  await page.waitForTimeout(3_500);
  expect(apiCalls.length).toBe(callsAtStart);

  // A student puts a piece in its place: the teacher's board and progress follow within 3 s.
  const placedAt = Date.now();
  await A.place({ locked: 1 });
  await expect(progress(page, 1)).toHaveAttribute('aria-valuetext', '12조각 중 1조각 (8%)', { timeout: 3_000 });
  const seenAfter = Date.now() - placedAt;
  testInfo.annotations.push({ type: 'piece locked -> teacher progress (ms)', description: String(seenAfter) });
  expect(seenAfter).toBeLessThan(3_000);
  await expect(card(page, 1).locator('.t-ov-pct')).toHaveText('8%');
  await expect.poll(() => page.locator('.t-ov-card canvas').first().evaluate((c) => c.toDataURL())).not.toBe(before);
  expect(await page.evaluate(() => window.__overview.model().groups[0].clusters.filter((c) => c.locked).length)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('overview-1-progress.png') });

  // Group 2 finishes: 완성 with the time taken, everywhere on the teacher's screen (D10).
  await C.place({ locked: 12 });
  await expect(card(page, 2)).toHaveClass(/is-done/, { timeout: 3_000 });
  await expect(card(page, 2).locator('.t-ov-pct')).toHaveText('완성');
  await expect(card(page, 2).locator('.t-ov-badge')).toHaveText(/^완성 · ((\d+분 )?\d+초|\d+분)$/);
  await expect(progress(page, 2)).toHaveAttribute('aria-valuenow', '100');
  await expect(page.locator('.t-ov-done')).toHaveText('완성 1 / 2모둠');
  await expect(page.locator('.t-ov-avg')).toHaveText('평균 진행률 54%'); // (8 + 100) / 2
  await expect(page.locator('[aria-live="polite"]', { hasText: '2모둠 완성했어요!' })).toBeAttached();
  expect(C.events.some((e) => e.type === 'complete')).toBe(true);
  await expect.poll(() => boardsDrawn(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('overview-2-done.png') });

  // Big view: the card opens it, arrows go to the other group, Escape returns to the card.
  await card(page, 1).getByRole('button', { name: '1모둠 크게 보기' }).click();
  const zoom = page.getByRole('dialog', { name: '1모둠' });
  await expect(zoom).toBeVisible();
  await expect(zoom.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '8');
  await expect(zoom.locator('.chip', { hasText: '민준' })).toBeVisible();
  await expect.poll(() => zoom.locator('canvas').evaluate((c) => c.width)).toBeGreaterThan(300);
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('overview-3-zoom.png') });
  await zoom.getByRole('button', { name: '다음 모둠' }).click();
  await expect(page.getByRole('dialog', { name: '2모둠' })).toContainText('모든 조각을 맞췄어요');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('dialog', { name: '1모둠' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card(page, 1).getByRole('button', { name: '1모둠 크게 보기' })).toBeFocused();

  // Code and QR again for a late student.
  await page.getByRole('button', { name: /코드 .*QR 크게 보기/ }).click();
  const codeBox = page.getByRole('dialog', { name: '늦게 온 학생은 이 코드로 들어와요' });
  await expect(codeBox.locator('.t-join-code')).toContainText(`${cls.code.slice(0, 3)} ${cls.code.slice(3)}`);
  await expect(codeBox.locator('.t-join-qr svg')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('overview-4-code.png') });
  await codeBox.getByRole('button', { name: '닫기' }).click();

  // A late student: shown as without a group, placed with the keyboard in 모둠 편성 (T9 way).
  const D = await nodeStudent(cls.code, '유나');
  await expect(page.locator('.t-ov-late')).toContainText('모둠이 없는 학생 1명');
  await expect(page.locator('.t-ov-late')).toContainText('유나');
  await page.getByRole('button', { name: '모둠에 넣기' }).click();
  const groupsDialog = page.getByRole('dialog', { name: '모둠 편성' });
  await expect(groupsDialog).toBeVisible();
  await groupsDialog.locator('.t-chip', { hasText: '유나' }).focus();
  await page.keyboard.press('Enter');
  await page.screenshot({ path: testInfo.outputPath('overview-5-grouping.png') });
  await groupsDialog.getByRole('button', { name: '유나를 1모둠에 놓기' }).click();
  await expect(groupsDialog.locator('.t-group', { hasText: '1모둠' }).locator('.t-chip', { hasText: '유나' })).toBeVisible();
  await groupsDialog.getByRole('button', { name: '다 했어요' }).click();
  const late = await D.ready();
  expect(late.group.number).toBe(1);
  expect(late.group.board.tray).toEqual([]); // came after the start: no tray
  await expect(card(page, 1).locator('.t-ov-mates .chip', { hasText: '유나' })).toBeVisible();
  await expect(page.locator('.t-ov-late')).toBeHidden();

  // A student who left: 잠시 나감 with the time away, counting up.
  B.leave();
  const away = card(page, 1).locator('.chip.off', { hasText: '서연' }).locator('em');
  await expect(away).toHaveText(/^잠시 나감 0:0\d$/, { timeout: 5_000 });
  await expect.poll(() => away.textContent(), { timeout: 5_000 }).toMatch(/^잠시 나감 0:0[2-9]$/);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('overview-6-away.png'), fullPage: true });

  // 수업 끝내기: asks first, then students hear of the end and the class data about them is gone (D14).
  await page.getByRole('button', { name: '수업 끝내기' }).click();
  const endDialog = page.getByRole('dialog', { name: '수업을 끝낼까요?' });
  await expect(endDialog).toBeVisible();
  await endDialog.getByRole('button', { name: '취소' }).click();
  expect((await sql('select status from jigsaw.sessions where id = $1', [cls.id])).rows[0].status).toBe('playing');
  await page.getByRole('button', { name: '수업 끝내기' }).click();
  await endDialog.getByRole('button', { name: '수업 끝내기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '수업을 끝냈어요' })).toBeVisible();
  await expect(page.locator('.t-empty .sub')).toContainText('완성한 모둠은 1 / 2모둠이에요.');
  for (const s of [A, C, D]) await expect.poll(() => s.events.some((e) => e.type === 'end')).toBe(true);
  await expect.poll(async () => (await sql('select status from jigsaw.sessions where id = $1', [cls.id])).rows[0].status).toBe('ended');
  await expect.poll(async () => (await sql('select count(*)::int as n from jigsaw.members where session_id = $1', [cls.id])).rows[0].n).toBe(0);
  // Their tokens stop working.
  const again = await fetch('http://127.0.0.1:3400/api/join', {
    method: 'POST',
    headers: { origin: 'http://localhost:4173', 'content-type': 'application/json' },
    body: JSON.stringify({ code: cls.code, name: '민준', token: A.token }),
  });
  expect(again.status).toBe(404);
  // No student name anywhere in the jigsaw schema.
  for (const table of ['sessions', 'groups', 'members']) {
    const { rows } = await sql(`select coalesce(string_agg(row_to_json(t)::text, ' '), '') as dump from jigsaw.${table} t`);
    for (const s of [A, B, C, D]) expect(rows[0].dump, `jigsaw.${table} has ${s.name}`).not.toContain(s.name);
  }
  await page.screenshot({ path: testInfo.outputPath('overview-7-ended.png') });

  expect(await violations(page)).toEqual([]);
  expect(teacher.errors).toEqual([]);
  await teacher.context.close();
});

// ---------- the look of a full class (mockup teacher-overview) ----------

const NAMES = [
  ['민준', '서연', '지호', '유나'],
  ['하은', '도윤', '서준', '지우'],
  ['예준', '수아', '시우', '연우'],
  ['하린', '주원', '지아', '은우'],
  ['채원', '건우', '윤서', '정우'],
  ['현우', '다은', '선우', '예린'],
];

async function fullClass({ pieces, perGroup, progress: plan, imageId = null, hints = {} }) {
  const cls = await openClass({ pieces, groups: plan.length, imageId, hints });
  const control = await classControl(cls);
  const groups = [];
  for (let g = 0; g < plan.length; g++) {
    const members = [];
    for (let k = 0; k < perGroup; k++) {
      const s = await nodeStudent(cls.code, NAMES[g][k]);
      await control.assign(s.memberId, g + 1);
      members.push(s);
    }
    groups.push(members);
  }
  await control.start();
  control.close();
  for (const [g, members] of groups.entries()) {
    for (const s of members) await s.ready();
    await playGroup(members, { ...plan[g], seed: g + 3 });
  }
  return { cls, groups };
}

test('the overview looks like the mockup: 6 groups on a 1920 x 1080 whiteboard and every screen size', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'sizes are set in the test');
  test.setTimeout(240_000);
  const { cls, groups } = await fullClass({
    pieces: 24,
    perGroup: 4,
    progress: [
      { locked: 15, loose: 5 },
      { locked: 9, loose: 7 },
      { locked: 24, loose: 0 },
      { locked: 4, loose: 9 },
      { locked: 12, loose: 6 },
      { locked: 18, loose: 4 },
    ],
  });
  const away = groups[1][1]; // 2모둠 도윤
  const sizes = [
    { name: 'whiteboard-1920', viewport: { width: 1920, height: 1080 } },
    { name: 'desktop-1440', viewport: { width: 1440, height: 900 } },
    { name: 'tablet-1024', viewport: { width: 1024, height: 768 } },
    { name: 'phone-390', viewport: { width: 390, height: 844 } },
    { name: 'phone-360', viewport: { width: 360, height: 780 } },
  ];
  for (const size of sizes) {
    const teacher = await openTeacher(browser, testInfo, cls.id, size.viewport);
    const { page } = teacher;
    await expect(page.locator('.t-ov-card')).toHaveCount(6);
    await expect(card(page, 3)).toHaveClass(/is-done/);
    await expect(card(page, 3).locator('.t-ov-badge')).toHaveText(/^완성 · ((\d+분 )?\d+초|\d+분)$/);
    await expect.poll(() => badgeCoversNothing(page, card(page, 3)), { message: `badge over the picture (${size.name})` }).toBe(true);
    await expect(page.locator('.t-ov-done')).toHaveText('완성 1 / 6모둠');
    await expect(page.locator('.t-ov-avg')).toHaveText('평균 진행률 57%'); // 62 37 100 16 50 75
    // 도윤 is here when the page opens, then leaves: the name stays, with the time away.
    if (!away.socket) await away.enter();
    await expect(card(page, 2).locator('.chip:not(.off)', { hasText: '도윤' })).toBeVisible();
    away.leave();
    await expect(card(page, 2).locator('.chip.off', { hasText: '도윤' })).toContainText(/잠시 나감 0:0\d/, { timeout: 5_000 });
    await expect(card(page, 1).locator('.chip', { hasText: '민준' })).toBeVisible();
    await expect(page.locator('.t-ov-clock')).toHaveText(/^\d+:\d\d$/);
    await expect.poll(() => boardsDrawn(page)).toBe(true);
    await expectNoHorizontalOverflow(page);
    for (const button of await page.locator('.t-ov-open, .t-bar button').all()) {
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    if (size.viewport.width >= 1000) {
      // Wide screens: all six groups fit without scrolling.
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
      const last = await card(page, 6).boundingBox();
      expect(last.y + last.height).toBeLessThanOrEqual(size.viewport.height);
      expect((await card(page, 1).locator('.t-ov-board').boundingBox()).height).toBeGreaterThan(150);
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: testInfo.outputPath(`overview-${size.name}.png`), fullPage: true });
    if (size.name === 'whiteboard-1920') {
      await card(page, 2).getByRole('button', { name: '2모둠 크게 보기' }).click();
      await expect.poll(() => page.locator('.t-ov-zoom canvas').evaluate((c) => c.width)).toBeGreaterThan(1000);
      await page.waitForTimeout(500);
      await page.screenshot({ path: testInfo.outputPath('overview-whiteboard-zoom.png') });
      await page.keyboard.press('Escape');
      await card(page, 3).getByRole('button', { name: '3모둠 크게 보기' }).click();
      const zoomDone = page.locator('.t-ov-zoom');
      await expect.poll(() => badgeCoversNothing(page, zoomDone), { message: 'badge over the big picture' }).toBe(true);
      await page.waitForTimeout(400);
      await page.screenshot({ path: testInfo.outputPath('overview-whiteboard-zoom-done.png') });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '모둠 편성' }).click();
      await expect(page.getByRole('dialog', { name: '모둠 편성' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('overview-whiteboard-grouping.png') });
      await page.keyboard.press('Escape');
    }
    if (size.name === 'phone-360') {
      await card(page, 1).getByRole('button', { name: '1모둠 크게 보기' }).click();
      await expect(page.getByRole('dialog', { name: '1모둠' })).toBeVisible();
      await page.waitForTimeout(400);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath('overview-phone-360-zoom.png') });
      await page.keyboard.press('Escape');
    }
    expect(await violations(page), size.name).toEqual([]);
    expect(teacher.errors, size.name).toEqual([]);
    await teacher.context.close();
  }
});

test('reduced motion: no progress transitions or badge pop (boards jump instead of sliding)', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet-1024', 'one size is enough');
  test.setTimeout(120_000);
  const { cls } = await fullClass({
    pieces: 12,
    perGroup: 1,
    progress: Array.from({ length: 6 }, (_, g) => (g === 0 ? { locked: 12, loose: 0 } : { locked: g, loose: 3 })),
  });
  const context = await browser.newContext({ ...testInfo.project.use, reducedMotion: 'reduce' });
  await signInPage(context);
  const page = await context.newPage();
  await page.goto(`/teacher/sessions/${cls.id}`);
  await expect(card(page, 1)).toHaveClass(/is-done/);
  const styles = await page.evaluate(() => ({
    bar: getComputedStyle(document.querySelector('.t-ov-prog i')).transitionDuration,
    badge: getComputedStyle(document.querySelector('.t-ov-badge')).animationName,
  }));
  expect(styles).toEqual({ bar: '0s', badge: 'none' });
  await context.close();
});

// ---------- a class with the teacher's own picture ----------

test("a class with the teacher's own picture: the boards cut it from the signed URL the server sent", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough');
  test.setTimeout(120_000);
  const image = await storeImage(readFileSync(new URL('../../public/images/builtin/sea.webp', import.meta.url)));
  createdImages.push(image.id);
  const { cls } = await fullClass({
    pieces: 12,
    perGroup: 1,
    imageId: image.id,
    hints: { underlay: true },
    progress: [{ locked: 5, loose: 4 }, {}],
  });

  const context = await browser.newContext({ ...testInfo.project.use });
  await watchCsp(context);
  await signInPage(context);
  const page = await context.newPage();
  const errors = watch(page, 'teacher', testInfo);
  const downloads = [];
  const direct = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.port !== '56321') return;
    if (url.pathname.startsWith(`/storage/v1/object/sign/jigsaw-images/`)) downloads.push(r.url());
    else direct.push(r.url());
  });
  await page.goto(`/teacher/sessions/${cls.id}`);
  await expect(page.locator('.t-ov-card')).toHaveCount(2);
  await expect(page.locator('.pill.t-summary')).toHaveText('내 그림 · 12조각');
  await expect.poll(() => boardsDrawn(page)).toBe(true);
  expect(downloads.length).toBe(1);
  expect(direct).toEqual([]);
  await expect(progress(page, 1)).toHaveAttribute('aria-valuetext', '12조각 중 5조각 (41%)');
  await page.screenshot({ path: testInfo.outputPath('overview-own-picture.png') });
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

// ---------- performance on a slow whiteboard PC ----------

test('6 groups x 70 pieces: redrawing the small boards on every push has no long task on a 4x slower CPU', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough (1920 whiteboard)');
  test.setTimeout(300_000);
  const { cls, groups } = await fullClass({
    pieces: 70,
    perGroup: 1,
    progress: Array.from({ length: 6 }, (_, g) => ({ locked: 10 + g * 5, loose: 30 })),
  });
  const teacher = await openTeacher(browser, testInfo, cls.id, { width: 1920, height: 1080 });
  const { page } = teacher;
  const pushes = countFrames(page, 'overview');
  await expect(page.locator('.t-ov-card')).toHaveCount(6);
  await expect.poll(() => boardsDrawn(page), { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(1_500);

  const cdp = await teacher.context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
    }).observe({ type: 'longtask' });
  });
  // Four rounds in which every group moves pieces and locks more (all boards redraw and slide).
  for (let round = 0; round < 4; round++) {
    const seen = pushes.length;
    for (const [s] of groups) {
      for (let k = 0; k < 3; k++) await s.nudge(round * 3 + k, 37, 23);
      await s.place({ locked: 2 });
    }
    await expect.poll(() => pushes.length, { timeout: 10_000 }).toBeGreaterThan(seen);
    await page.waitForTimeout(1_200); // slides finish
  }
  const longTasks = await page.evaluate(() => window.__longTasks);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  testInfo.annotations.push({ type: 'long tasks (ms, 4x CPU, 6 x 70 pieces)', description: JSON.stringify(longTasks) });
  console.log('[overview 6 x 70] long tasks at 4x CPU:', longTasks);
  await page.screenshot({ path: testInfo.outputPath('overview-6x70.png') });
  expect(longTasks.filter((ms) => ms > 50)).toEqual([]);
  expect(await violations(page)).toEqual([]);
  expect(teacher.errors).toEqual([]);
  await teacher.context.close();
});
