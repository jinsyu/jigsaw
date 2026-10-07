import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, finishFrame, placeAll, puzzleState } from './support/puzzle.js';
import { RT_LOG_FILE } from './support/rt-log.js';
import { cspViolations, joinStudent, supabaseHosts } from './support/student.js';
import { cleanUpClasses, closeSql, signInPage, sql, trackClass } from './support/teacher.js';

// T23: one whole class in the browser at every screen size (the project's), as in a classroom:
// the teacher opens it on 새 수업, five students join with the code, the teacher shuffles them
// into two groups and starts, every student puts their pieces in, both groups finish, the
// teacher sees it on the overview and ends the class (D1, D3~D5, D10, D11, D13~D15).

const NAMES = ['가람', '나래', '다솜', '라온', '마루'];

test.afterAll(async () => {
  await cleanUpClasses();
  await closeSql();
});

async function watchCsp(context) {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

const card = (page, number) => page.locator('.t-ov-card', { has: page.getByRole('heading', { level: 2, name: `${number}모둠`, exact: true }) });

test('a whole class: teacher and five students, from 새 수업 to 수업 끝내기', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const size = testInfo.project.name;

  // The teacher opens a class: 12 pieces, 2 groups.
  const teacherContext = await browser.newContext({ ...testInfo.project.use });
  await watchCsp(teacherContext);
  await signInPage(teacherContext);
  const page = await teacherContext.newPage();
  const teacherErrors = [];
  page.on('pageerror', (e) => teacherErrors.push(e.message));
  const teacherHosts = new Set();
  page.on('request', (r) => teacherHosts.add(new URL(r.url()).host));
  page.on('websocket', (ws) => teacherHosts.add(new URL(ws.url()).host));
  await page.goto('/teacher/new');
  await expect(page.locator('.t-preview svg')).toBeVisible();
  await page.locator('.t-seg label', { hasText: /^12$/ }).click();
  await expect(page.locator('.t-lbl small')).toHaveText('12조각 미리보기');
  const groupCount = page.getByRole('spinbutton', { name: '모둠 수', exact: true });
  await groupCount.fill('2');
  await groupCount.blur();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: '수업 열기' }).click();
  await expect(page).toHaveURL(/\/teacher\/sessions\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').at(-1);
  await trackClass(id);
  const code = await page.locator('.t-join-code').getAttribute('data-code');
  expect(code).toMatch(/^\d{6}$/);
  await expect(page.locator('.t-summary')).toContainText('12조각 · 2모둠');
  await expectNoHorizontalOverflow(page);

  // Five students join with the code; their names reach the lobby.
  const students = [];
  for (const name of NAMES) {
    students.push(await joinStudent(browser, testInfo, { code }, name));
    await expect(page.locator('.t-pool .t-chip', { hasText: name })).toBeVisible();
  }
  await expect(page.locator('.t-join-wait')).toHaveText('들어온 학생 5명');
  await expectNoHorizontalOverflow(students[0].page);
  await page.screenshot({ path: testInfo.outputPath(`full-1-lobby-${size}.png`), fullPage: true });

  // 무작위로 나누기 (3 + 2), then 시작하기: the lobby turns into the overview.
  await page.getByRole('button', { name: '무작위로 나누기' }).click();
  await expect(page.locator('.t-pool .t-empty-line')).toHaveText('모든 학생이 모둠에 들어갔어요.');
  await page.getByRole('button', { name: '시작하기' }).click();
  await expect(page.locator('.t-ov-card')).toHaveCount(2);
  const groups = { 1: [], 2: [] };
  for (const s of students) {
    await expect(s.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15_000 });
    const heading = await s.page.getByRole('heading', { level: 1 }).textContent();
    groups[Number(heading.match(/^(\d)모둠$/)[1])].push(s);
  }
  expect([groups[1].length, groups[2].length].sort()).toEqual([2, 3]);
  // D5: each group's 12 pieces are dealt evenly (4 / 4 / 4 or 6 / 6).
  for (const members of Object.values(groups)) {
    const trays = [];
    for (const s of members) trays.push((await puzzleState(s.page)).tray);
    expect(trays.map((t) => t.length)).toEqual(members.map(() => 12 / members.length));
    expect(trays.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  }
  for (const s of students) await expectNoHorizontalOverflow(s.page);
  await students[0].page.screenshot({ path: testInfo.outputPath(`full-2-puzzle-${size}.png`) });

  // Everyone puts their pieces into the frame; the teacher's overview follows.
  for (const s of students) await placeAll(s.page, s.input);
  for (const [number, members] of Object.entries(groups)) {
    // Every piece is on that screen's board (the others' last drops have arrived), then the rest.
    await expect.poll(async () => (await puzzleState(members[0].page)).clusters.reduce((n, c) => n + c.pieces.length, 0)).toBe(12);
    await finishFrame(members[0].page, members[0].input);
    for (const s of members) {
      await expect(s.page.getByRole('heading', { level: 1, name: `${number}모둠 완성!` })).toBeVisible({ timeout: 15_000 });
      await expect(s.page.locator('.st-done .sub')).toContainText(s.name);
      await expectNoHorizontalOverflow(s.page);
    }
    await expect(card(page, number)).toHaveClass(/is-done/);
  }
  await expect(page.locator('.t-ov-done')).toHaveText('완성 2 / 2모둠');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(`full-3-overview-${size}.png`), fullPage: true });
  await students[0].page.screenshot({ path: testInfo.outputPath(`full-4-complete-${size}.png`), fullPage: true });

  // 수업 끝내기: students hear of it; nothing about them is left in the database (D14).
  await page.getByRole('button', { name: '수업 끝내기' }).click();
  await page.getByRole('dialog', { name: '수업을 끝낼까요?' }).getByRole('button', { name: '수업 끝내기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '수업을 끝냈어요' })).toBeVisible();
  await expect(page.locator('.t-empty .sub')).toContainText('완성한 모둠은 2 / 2모둠이에요.');
  for (const s of students) await expect(s.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible();
  await expect.poll(async () => (await sql('select count(*)::int as n from jigsaw.members where session_id = $1', [id])).rows[0].n).toBe(0);
  for (const table of ['sessions', 'groups', 'members']) {
    const { rows } = await sql(`select coalesce(string_agg(row_to_json(t)::text, ' '), '') as dump from jigsaw.${table} t`);
    for (const name of NAMES) expect(rows[0].dump, `jigsaw.${table} has ${name}`).not.toContain(name);
  }
  const log = readFileSync(RT_LOG_FILE, 'utf8');
  for (const name of NAMES) expect(log, `rt server log has ${name}`).not.toContain(name);

  // Every screen ran under the CSP, without errors, and talked only to the allowed hosts.
  expect(await cspViolations(page)).toEqual([]);
  expect(teacherErrors).toEqual([]);
  expect(supabaseHosts(teacherHosts)).toEqual([]);
  for (const s of students) {
    expect(await cspViolations(s.page), s.name).toEqual([]);
    expect(s.errors, s.name).toEqual([]);
    expect(supabaseHosts(s.hosts), s.name).toEqual([]);
    await s.context.close();
  }
  await teacherContext.close();
});
