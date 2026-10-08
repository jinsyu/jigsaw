import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { WIDE } from './support/pictures.js';
import { devTeacherToken, LOCAL_TEACHER_ID, teacherAuthInitScript } from '../../scripts/lib/local-teacher.mjs';
import { dragFromTray, expectNoHorizontalOverflow, finishFrame, frameOrigin, placeAll, puzzleState, showFrame } from './support/puzzle.js';
import { startRtServer } from './support/rt-server.js';
import { cspViolations, studentContext } from './support/student.js';
import { closeSql, sql } from './support/teacher.js';

// T23 (D17): the rt server dies in the middle of a puzzle and comes back. The teacher's and the
// students' screens reconnect by themselves, and the board goes on from the last save (at most
// 2 s old): the same pieces in the frame, the same loose piece, the same trays, no holds.
//
// This test runs its own rt server on port 3401 (killed and started again here), alone after
// every other test (playwright.config.js), because a starting rt server takes over every open
// class of the database. The pages are pointed at it by changing the local rt port in
// config.js and in the local CSP header.

const PORT = 3401;
const ORIGIN = 'http://localhost:4173';
const NAMES = ['바다', '하늘'];
const sessionIds = [];
let server = null;

test.afterAll(async () => {
  await server?.kill('SIGTERM');
  if (sessionIds.length) await sql('delete from jigsaw.sessions where id = any($1::uuid[])', [sessionIds]);
  await closeSql();
});

// Every request of the context to the local site: config.js and the CSP name port 3401.
// A page whose document Playwright fulfilled counts as outside the local network for Chrome's
// Local Network Access check, so the context is allowed to reach 127.0.0.1 (as the pages served
// straight from the local server are).
async function useRtPort(context, baseURL) {
  await context.grantPermissions(['local-network-access']);
  await context.route(`${baseURL}/**`, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].replaceAll(':3400', `:${PORT}`);
    if (new URL(route.request().url()).pathname !== '/js/config.js') return route.fulfill({ response, headers });
    const text = await response.text();
    const body = text.replace('const LOCAL_RT_PORT = 3400;', `const LOCAL_RT_PORT = ${PORT};`);
    if (body === text) throw new Error('config.js has no LOCAL_RT_PORT = 3400 to replace');
    return route.fulfill({ response, headers, body });
  });
}

// What a screen shows of the board, in a form to compare across the restart.
async function boardOf(page) {
  const s = await puzzleState(page);
  return {
    clusters: s.clusters
      .map((c) => ({ id: c.id, x: c.x, y: c.y, locked: Boolean(c.locked), pieces: c.pieces.map(([col, row]) => `${col},${row}`).sort() }))
      .sort((a, b) => a.id - b.id),
    tray: [...s.tray].sort((a, b) => a - b),
    placed: s.progress.placed,
  };
}

test('D17: the rt server is killed during a puzzle; the screens reconnect and the board goes on', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const secret = randomBytes(32).toString('hex');
  server = await startRtServer({ port: PORT, secret });
  const outputs = [];

  // A class of 12 pieces in one group, opened through this server's API.
  const token = await devTeacherToken({ rtUrl: server.url, origin: ORIGIN, teacherId: LOCAL_TEACHER_ID });
  const res = await fetch(`${server.url}/api/sessions`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pieceCount: 12, groupCount: 1, picture: { builtinKey: WIDE }, hints: {} }),
  });
  const cls = await res.json();
  expect(res.status, JSON.stringify(cls)).toBe(200);
  sessionIds.push(cls.sessionId);

  // The teacher's lobby, then two students join on their own devices.
  const teacherContext = await browser.newContext({ ...testInfo.project.use });
  await teacherContext.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await teacherContext.addInitScript(...teacherAuthInitScript(token));
  await useRtPort(teacherContext, baseURL);
  const teacher = await teacherContext.newPage();
  const teacherErrors = [];
  teacher.on('pageerror', (e) => teacherErrors.push(e.message));
  await teacher.goto(`/teacher/sessions/${cls.sessionId}`);
  await expect(teacher.locator('.t-join-code')).toHaveAttribute('data-code', cls.code);

  const students = [];
  for (const name of NAMES) {
    const s = await studentContext(browser, testInfo, name);
    await useRtPort(s.context, baseURL);
    await s.page.goto(`/join?code=${cls.code}`);
    await s.page.getByLabel('내 이름').fill(name);
    await s.page.getByRole('button', { name: '다음' }).click();
    await expect(s.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
    await expect(teacher.locator('.t-pool .t-chip', { hasText: name })).toBeVisible();
    students.push(s);
  }
  const [A, B] = students;
  await teacher.getByRole('button', { name: '무작위로 나누기' }).click();
  await teacher.getByRole('button', { name: '시작하기' }).click();
  await expect(teacher.locator('.t-ov-card')).toHaveCount(1);
  for (const s of students) await expect(s.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15_000 });

  // A puts one piece in its place in the frame, B takes one out of the tray (loose on the board).
  await showFrame(A.page, A.input);
  const { ox, oy } = await frameOrigin(A.page);
  await dragFromTray(A.page, A.input, (await puzzleState(A.page)).tray[0], ox, oy);
  const loosePiece = (await puzzleState(B.page)).tray[0];
  await B.page.locator(`.pz-tile[data-piece="${loosePiece}"]`).click();
  for (const s of students) await expect.poll(async () => (await puzzleState(s.page)).clusters.length).toBe(2);
  await expect(teacher.locator('.t-ov-card').getByRole('progressbar')).toHaveAttribute('aria-valuetext', '12조각 중 1조각 (8%)');
  const before = { A: await boardOf(A.page), B: await boardOf(B.page) };
  expect(before.A.clusters).toEqual(before.B.clusters);
  expect(before.A.clusters.filter((c) => c.locked)).toHaveLength(1);
  expect(before.A.tray).toHaveLength(5);
  expect(before.B.tray).toHaveLength(5);
  // Past the 2-second batched board save, then the process dies (no time to save anything).
  await A.page.waitForTimeout(2_500);
  outputs.push(server.output());
  await server.kill('SIGKILL');

  // Every screen says it is reconnecting.
  const studentBand = (s) => s.page.getByRole('status').filter({ hasText: '연결이 끊겼어요. 다시 연결하는 중이에요…' });
  const teacherBand = teacher.getByRole('status').filter({ hasText: '서버와 연결이 끊겼어요. 다시 연결하는 중이에요…' });
  for (const s of students) await expect(studentBand(s)).toBeVisible({ timeout: 20_000 });
  await expect(teacherBand).toBeVisible({ timeout: 20_000 });
  await A.page.screenshot({ path: testInfo.outputPath('restart-1-reconnecting.png') });

  // The server comes back (same secret, as in production): it restores the class from the
  // database, and the screens reconnect without anyone touching them.
  server = await startRtServer({ port: PORT, secret });
  expect(server.output()).toMatch(/복구한 수업 [1-9]\d*개/);
  for (const s of students) await expect(studentBand(s)).toBeHidden({ timeout: 20_000 });
  await expect(teacherBand).toBeHidden({ timeout: 20_000 });

  // The same board on both screens as before the crash; nobody holds anything; friends online.
  for (const s of students) {
    await expect.poll(() => boardOf(s.page), { timeout: 10_000 }).toEqual(before[s === A ? 'A' : 'B']);
    expect(await s.page.evaluate(() => window.__puzzle.holders())).toEqual([]);
    // Friends online again (no '잠시 나감'; my own chip says 나).
    for (const other of students.filter((o) => o !== s)) await expect(s.page.locator('.pz-chips .chip', { hasText: other.name }).locator('em')).toHaveCount(0);
    await expectNoHorizontalOverflow(s.page);
  }
  await expect(teacher.locator('.t-ov-card').getByRole('progressbar')).toHaveAttribute('aria-valuetext', '12조각 중 1조각 (8%)');
  // The restored server's own board (the teacher's overview gets it fresh after reconnecting).
  const positions = (clusters) => clusters.map((c) => ({ id: c.id, x: c.x, y: c.y, locked: Boolean(c.locked) })).sort((a, b) => a.id - b.id);
  await expect
    .poll(async () => positions(await teacher.evaluate(() => window.__overview.model().groups[0].clusters)))
    .toEqual(positions(before.A.clusters));
  for (const name of NAMES) await expect(teacher.locator('.t-ov-mates .chip', { hasText: name })).toBeVisible();
  await expect(teacher.locator('.t-ov-mates .chip.off')).toHaveCount(0);
  await A.page.screenshot({ path: testInfo.outputPath('restart-2-back.png') });

  // The puzzle goes on to the end.
  for (const s of students) await placeAll(s.page, s.input);
  await expect.poll(async () => (await puzzleState(B.page)).clusters.reduce((n, c) => n + c.pieces.length, 0)).toBe(12);
  await finishFrame(B.page, B.input);
  for (const s of students) await expect(s.page.getByRole('heading', { level: 1, name: '1모둠 완성!' })).toBeVisible({ timeout: 15_000 });
  await expect(teacher.locator('.t-ov-card')).toHaveClass(/is-done/);

  // Ends the class; no student name in the database or in either server's output (D14).
  await teacher.getByRole('button', { name: '수업 끝내기' }).click();
  await teacher.getByRole('dialog', { name: '수업을 끝낼까요?' }).getByRole('button', { name: '수업 끝내기' }).click();
  for (const s of students) await expect(s.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible();
  outputs.push(server.output());
  for (const table of ['sessions', 'groups', 'members']) {
    const { rows } = await sql(`select coalesce(string_agg(row_to_json(t)::text, ' '), '') as dump from jigsaw.${table} t`);
    for (const name of NAMES) expect(rows[0].dump, `jigsaw.${table} has ${name}`).not.toContain(name);
  }
  for (const name of NAMES) expect(outputs.join('\n'), `rt server output has ${name}`).not.toContain(name);

  expect(await cspViolations(teacher)).toEqual([]);
  expect(teacherErrors).toEqual([]);
  for (const s of students) {
    expect(await cspViolations(s.page), s.name).toEqual([]);
    expect(s.errors, s.name).toEqual([]);
    await s.context.close();
  }
  await teacherContext.close();
});
