import { expect, test } from '@playwright/test';
import { closeSql, deleteSessions, signInPage, sql, teacherSession } from './support/teacher.js';

// Every page under the CSP: no violations, and requests only go to this site, the CDN
// (supabase-js, Pretendard) and Supabase (the local stack here).
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
  await deleteSessions(createdSessions.splice(0));
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
  const allowed = new Set([self, 'cdn.jsdelivr.net', '127.0.0.1:56321']);
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

test('joining a class under the CSP: student join, waiting with a group, teacher lobby, puzzle', async ({ browser, page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one browser size is enough');
  const { client } = await teacherSession();
  const { data: session, error } = await client.rpc('create_session', {
    p_piece_count: 24,
    p_group_count: 3,
    p_builtin_key: 'sea',
    p_aspect: 1800 / 1200,
  });
  if (error) throw error;
  createdSessions.push(session.id);

  await watchCsp(context);
  await signInPage(context);
  await page.goto(`/teacher/sessions/${session.id}`);
  await expect(page.locator('.t-join-wait')).toBeVisible();

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
  await expect(page.locator('.t-chip', { hasText: '별님' })).toBeVisible();

  // Groups: the lobby grid (--group-cols) and the student's own colour (--me), both inline styles.
  const { error: groupError } = await client.rpc('randomize_groups', { p_session: session.id });
  if (groupError) throw groupError;
  await expect(s.locator('.st-mate.is-me')).toBeVisible();
  await expect(page.locator('.t-group .t-chip', { hasText: '별님' })).toBeVisible();
  expect(await s.locator('.st-mate.is-me').evaluate((el) => el.style.getPropertyValue('--me'))).toMatch(/^#|rgb/);
  expect(await page.locator('.t-groups').evaluate((el) => el.style.getPropertyValue('--group-cols'))).not.toBe('');

  expect(await violations(s), 'student waiting with a group').toEqual([]);
  expect(await violations(page), 'teacher lobby').toEqual([]);

  // Started: the group puzzle (canvas, tray tiles, member chips, holds) under the CSP too.
  const { error: startError } = await client.rpc('start_session', { p_session: session.id });
  if (startError) throw startError;
  await expect(s.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  await s.locator('.pz-tile').first().click();
  await expect.poll(() => s.evaluate(() => window.__puzzle.state().clusters.length)).toBe(1);
  expect(await violations(s), 'student puzzle').toEqual([]);
  await student.close();
});
