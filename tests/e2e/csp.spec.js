import { expect, test } from '@playwright/test';
import { deleteLegacySessions, legacyTeacher } from './support/legacy.js';
import { classControl, cleanUpClasses, closeSql, nodeStudent, openClass, signInPage, sql } from './support/teacher.js';

// Every page under the CSP: no violations, and requests only go to this site, the CDN
// (Pretendard; supabase-js for the student screens until T22), Supabase and the rt server
// (the local stack here).
const PAGES = ['/', '/privacy', '/play?demo=1', '/play?demo=1&picture=giraffe', '/teacher', '/join'];
const createdSessions = [];

test.afterAll(async () => {
  if (createdSessions.length) {
    await sql(
      `delete from auth.users where is_anonymous and id in
         (select user_id from public.members where session_id = any($1::bigint[]))`,
      [createdSessions],
    );
  }
  await deleteLegacySessions(createdSessions.splice(0));
  await cleanUpClasses();
  await closeSql();
});

// Records CSP violations from the first script on every page of the context.
async function watchCsp(context) {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
  });
}
const violations = (page) => page.evaluate(() => window.__cspViolations);

test('pages load under the Content-Security-Policy and talk only to allowed hosts', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one browser size is enough');
  const self = new URL(baseURL).host;
  const allowed = new Set([self, 'cdn.jsdelivr.net', '127.0.0.1:56321', '127.0.0.1:3400']);
  const hosts = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') || url.protocol.startsWith('ws')) hosts.add(url.host);
  });
  await watchCsp(page.context());
  for (const path of PAGES) {
    const response = await page.goto(path);
    expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
    await page.waitForLoadState('networkidle');
    expect(await violations(page), path).toEqual([]);
  }
  testInfo.annotations.push({ type: 'hosts', description: [...hosts].join(', ') });
  expect([...hosts].filter((h) => !allowed.has(h))).toEqual([]);
});

test('joining a class under the CSP (student screens, old structure until T22): join, waiting with a group, puzzle', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one browser size is enough');
  const { client } = await legacyTeacher();
  const { data: session, error } = await client.rpc('create_session', {
    p_piece_count: 24,
    p_group_count: 3,
    p_builtin_key: 'sea',
    p_aspect: 1800 / 1200,
  });
  if (error) throw error;
  createdSessions.push(session.id);

  const student = await browser.newContext({ ...testInfo.project.use });
  await watchCsp(student);
  const s = await student.newPage();
  await s.goto('/join');
  await expect(s.getByLabel('수업 코드 6자리')).toBeVisible();
  expect(await violations(s), '/join').toEqual([]);
  await s.goto(`/join?code=${session.code}`);
  await expect(s.getByRole('heading', { level: 1, name: '이름을 알려 주세요' })).toBeVisible();
  expect(await violations(s), '/join?code=').toEqual([]);
  await s.getByLabel('내 이름').fill('별님');
  await s.getByRole('button', { name: '다음' }).click();
  await expect(s.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();

  // Groups: the student's own colour (--me) is an inline style.
  const { error: groupError } = await client.rpc('randomize_groups', { p_session: session.id });
  if (groupError) throw groupError;
  await expect(s.locator('.st-mate.is-me')).toBeVisible();
  expect(await s.locator('.st-mate.is-me').evaluate((el) => el.style.getPropertyValue('--me'))).toMatch(/^#|rgb/);
  expect(await violations(s), 'student waiting with a group').toEqual([]);

  // Started: the group puzzle (canvas, tray tiles, member chips, holds) under the CSP too.
  const { error: startError } = await client.rpc('start_session', { p_session: session.id });
  if (startError) throw startError;
  await expect(s.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  await s.locator('.pz-tile').first().click();
  await expect.poll(() => s.evaluate(() => window.__puzzle.state().clusters.length)).toBe(1);
  expect(await violations(s), 'student puzzle').toEqual([]);
  await student.close();
});

test('teacher screens under the CSP: 새 수업, the lobby with a student, the overview — only this site, the CDN and the rt server', async ({ page, context, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one browser size is enough');
  const self = new URL(baseURL).host;
  const hosts = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') || url.protocol.startsWith('ws')) hosts.add(url.host);
  });
  page.on('websocket', (ws) => hosts.add(new URL(ws.url()).host));
  await watchCsp(context);
  await signInPage(context);
  // 새 수업 만들기 first (thumbnails, previews, the source line), then the lobby.
  await page.goto('/teacher/new');
  await expect(page.locator('.t-preview svg')).toBeVisible();
  await page.getByRole('group', { name: '내장 그림 분류' }).getByRole('button', { name: /명화/ }).click();
  await page.locator('#t-builtin-grid .t-pic:visible').first().click();
  await expect(page.locator('#t-credit a').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await violations(page), '/teacher/new').toEqual([]);

  const cls = await openClass({ pieces: 12, groups: 3 });
  await page.goto(`/teacher/sessions/${cls.id}`);
  await expect(page.locator('.t-join-wait')).toBeVisible();
  const student = await nodeStudent(cls.code, '별님');
  await expect(page.locator('.t-chip', { hasText: '별님' })).toBeVisible();
  // The lobby grid (--group-cols) is an inline style.
  await page.getByRole('button', { name: '무작위로 나누기' }).click();
  await expect(page.locator('.t-group .t-chip', { hasText: '별님' })).toBeVisible();
  expect(await page.locator('.t-groups').evaluate((el) => el.style.getPropertyValue('--group-cols'))).not.toBe('');
  expect(await violations(page), 'teacher lobby').toEqual([]);

  // The overview: canvases, progress bars and the grid (--ov-cols) under the CSP too.
  const control = await classControl(cls);
  await control.start();
  control.close();
  await expect(page.locator('.t-ov-card')).toHaveCount(3);
  await student.ready();
  await student.place({ locked: 1 });
  await expect(page.locator('.t-ov-card:not(.is-empty)').getByRole('progressbar')).toHaveAttribute('aria-valuetext', '12조각 중 1조각 (8%)');
  expect(await page.locator('.t-ov-grid').evaluate((el) => el.style.getPropertyValue('--ov-cols'))).not.toBe('');
  expect(await violations(page), 'teacher overview').toEqual([]);
  testInfo.annotations.push({ type: 'hosts', description: [...hosts].join(', ') });
  expect([...hosts].filter((h) => ![self, 'cdn.jsdelivr.net', '127.0.0.1:3400'].includes(h))).toEqual([]);
});
