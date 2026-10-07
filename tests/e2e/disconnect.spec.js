import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, puzzleState as state } from './support/puzzle.js';
import { joinStudent, startInOneGroup } from './support/student.js';
import { classControl, cleanUpClasses, closeSql, openClass, rtApi } from './support/teacher.js';

// D9 one-minute rule with the browser screens (spec rule 7). The rt server's clock is moved
// forward with its local test hook instead of waiting; that moves it for every class on the
// server, so this file runs alone after all the others (playwright.config.js, project clock-390).

test.afterAll(async () => {
  await cleanUpClasses();
  await closeSql();
});

const sorted = (list) => [...list].sort((a, b) => a - b);
const trayOf = async (student) => sorted((await state(student.page)).tray);

async function advanceClock(ms) {
  const { status } = await rtApi('/api/test/clock', { method: 'POST', json: { advanceMs: ms } });
  expect(status).toBe(200);
}

test('D9: back within a minute keeps the tray; gone over a minute, the tray goes to the friends online', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const cls = await openClass({ pieces: 12, groups: 2 });
  const control = await classControl(cls);
  const students = [];
  for (const name of ['가온', '나은', '다빈']) students.push(await joinStudent(browser, testInfo, cls, name));
  const [A, B, C] = students;
  await startInOneGroup(control, students);
  const before = Object.fromEntries(await Promise.all(students.map(async (s) => [s.name, await trayOf(s)])));
  for (const s of students) expect(before[s.name]).toHaveLength(4);

  // C closes the page; 50 s later (server clock) the same device opens the class again.
  await C.page.close();
  for (const s of [A, B]) {
    await expect(s.page.locator('.pz-chips .chip', { hasText: C.name }).locator('em')).toHaveText('잠시 나감', { timeout: 15000 });
  }
  await advanceClock(50_000);
  await C.newPage();
  await C.page.goto('/play');
  await expect(C.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  expect(await trayOf(C)).toEqual(before[C.name]);
  for (const s of [A, B]) expect(await trayOf(s)).toEqual(before[s.name]);
  await expect(A.page.locator('.pz-chips .chip', { hasText: C.name }).locator('em')).toHaveCount(0);

  // C goes again and stays away for over a minute: A and B get C's pieces, 2 each.
  await C.page.close();
  await expect(A.page.locator('.pz-chips .chip', { hasText: C.name }).locator('em')).toHaveText('잠시 나감', { timeout: 15000 });
  await advanceClock(61_000);
  for (const s of [A, B]) {
    await expect.poll(async () => (await trayOf(s)).length, { timeout: 10_000 }).toBe(6);
    await expect(s.page.locator('.pz-tile')).toHaveCount(6);
  }
  const gotA = (await trayOf(A)).filter((p) => before[C.name].includes(p));
  const gotB = (await trayOf(B)).filter((p) => before[C.name].includes(p));
  expect(sorted([...gotA, ...gotB])).toEqual(before[C.name]);
  expect(Math.abs(gotA.length - gotB.length)).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(A.page);
  await A.page.screenshot({ path: testInfo.outputPath('disconnect-dealt.png') });

  // C comes back later: an empty tray, still in the group, playing with the board.
  await C.newPage();
  await C.page.goto('/play');
  await expect(C.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  await expect(C.page.locator('.pz-tile')).toHaveCount(0);
  await expect(C.page.getByText('상자가 비었어요. 판 위 조각을 함께 맞춰요')).toBeVisible();

  for (const s of students) {
    expect(s.errors).toEqual([]);
    await s.context.close();
  }
  control.close();
});
