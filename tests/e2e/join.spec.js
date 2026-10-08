import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './support/puzzle.js';
import { RT_LOG_FILE } from './support/rt-log.js';
import { savedEntry, savedKeyOf, studentContext, supabaseHosts } from './support/student.js';
import { ORIGIN, classControl, cleanUpClasses, closeSql, openClass, sql } from './support/teacher.js';
import { HOSTED_RT, SITE, asHostedSite, rtAnswer } from './support/production.js';

// T9 → T22: students join with a code and a name through the rt server (POST /api/join, then
// the class socket), wait, get their group and start (D3, D4, D14). Several browser contexts
// play the students; the teacher's moves come from Node (the lobby itself: teacher.spec.js).

test.afterAll(async () => {
  await cleanUpClasses();
  await closeSql();
});

test('D3·D4·D14: students join by code or QR, get their groups and start', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const cls = await openClass({ pieces: 24, groups: 4 });
  const control = await classControl(cls);

  // Student A types the code on the home page (six cells).
  const a = await studentContext(browser, testInfo, '다솜이');
  await a.page.goto('/');
  const codeInput = a.page.getByLabel('수업 코드 6자리');
  await codeInput.fill(cls.code.slice(0, 3));
  await expect(a.page.locator('.code-cells span.is-filled')).toHaveCount(3);
  await expect(a.page.locator('.code-cells span.is-cur')).toHaveCount(1);
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-1-code.png') });
  await codeInput.fill(cls.code);
  await a.page.getByRole('button', { name: '들어가기' }).click();
  await expect(a.page.getByRole('heading', { level: 1, name: '이름을 알려 주세요' })).toBeVisible();
  await expect(a.page.locator('.st-topnav .pill')).toHaveText(`수업 ${cls.code.slice(0, 3)} ${cls.code.slice(3)}`);
  await expect(a.page.getByText('이름은 저장하지 않아요.')).toBeVisible();
  await a.page.getByLabel('내 이름').fill('  다솜이 ');
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-2-name.png') });
  await a.page.getByRole('button', { name: '다음' }).click();
  await expect(a.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  // D3: the teacher has the name.
  await control.memberId('다솜이');
  // The device keeps the name and the student token under the class code (nothing else).
  const savedA = await savedEntry(a.page, cls.code);
  expect(savedA).toMatchObject({ v: 2, name: '다솜이', code: cls.code });
  expect(savedA.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

  // Student B scans the QR: the code is already in the address, so only the name is asked.
  const b = await studentContext(browser, testInfo, '보람찬');
  await b.page.goto(`/join?code=${cls.code}`);
  await expect(b.page.getByRole('heading', { level: 1, name: '이름을 알려 주세요' })).toBeVisible();
  await b.page.getByLabel('내 이름').fill('보람찬');
  await b.page.getByLabel('내 이름').press('Enter');
  await expect(b.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();

  // Student C mistypes the code: told to check it, keeps the name, goes straight in after fixing it.
  const wrong = cls.code === '000000' ? '000001' : '000000';
  const c = await studentContext(browser, testInfo, '한결이');
  await c.page.goto(`/join?code=${wrong}`);
  await c.page.getByLabel('내 이름').fill('한결이');
  await c.page.getByRole('button', { name: '다음' }).click();
  await expect(c.page.getByRole('alert')).toHaveText('코드를 다시 확인해 주세요');
  await expect(c.page.getByLabel('수업 코드 6자리')).toHaveValue(wrong);
  await expectNoHorizontalOverflow(c.page);
  await c.page.screenshot({ path: testInfo.outputPath('student-1-wrong-code.png') });
  await c.page.getByLabel('수업 코드 6자리').fill(cls.code);
  await c.page.getByRole('button', { name: '들어가기' }).click();
  await expect(c.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  await expect(c.page.getByText('한결이, 잘 들어왔어요!')).toBeVisible();
  await expectNoHorizontalOverflow(c.page);
  await c.page.screenshot({ path: testInfo.outputPath('student-3-waiting.png') });

  // 무작위로 나누기: everyone gets a group, and each student screen shows it.
  await control.randomize();
  for (const [student, name] of [
    [a, '다솜이'],
    [b, '보람찬'],
    [c, '한결이'],
  ]) {
    await expect.poll(() => control.member(name)?.group ?? null).not.toBeNull();
    await expect(student.page.getByRole('heading', { level: 1 })).toHaveText(`${name}, ${control.member(name).group}모둠이에요!`);
    await expect(student.page.locator('.st-mate.is-me')).toContainText(name);
  }

  // Moves: 다솜이 into 1모둠, 보람찬 into 2모둠, 한결이 back to no group.
  await control.assign(await control.memberId('다솜이'), 1);
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('다솜이, 1모둠이에요!');
  await control.assign(await control.memberId('보람찬'), 2);
  await expect(b.page.getByRole('heading', { level: 1 })).toHaveText('보람찬, 2모둠이에요!');
  await control.assign(await control.memberId('한결이'), null);
  await expect(c.page.getByRole('heading', { level: 1 })).toHaveText('선생님이 모둠을 정하고 있어요');

  // Same group as A: put C into 1모둠 to check groupmates on both screens.
  await control.assign(await control.memberId('한결이'), 1);
  await expect(a.page.locator('.st-mate', { hasText: '한결이' })).toBeVisible();
  await expect(c.page.locator('.st-mate', { hasText: '다솜이' })).toBeVisible();
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-3-waiting-group.png') });

  // 시작하기 → every student gets their own group's puzzle, on /play (not the demo).
  await control.start();
  for (const [student, number] of [
    [a, 1],
    [b, 2],
    [c, 1],
  ]) {
    await expect(student.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
    await expect(student.page.getByRole('heading', { level: 1 })).toHaveText(`${number}모둠`);
    await expect(student.page).toHaveURL(/\/play$/);
    expect(await student.page.evaluate(() => window.__puzzleDemo)).toBeUndefined();
  }
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-4-started.png') });
  expect((await sql('select status from jigsaw.sessions where id = $1', [cls.id])).rows[0].status).toBe('playing');

  // Same device again: back to the same name, group and tray without asking.
  const tray = await a.page.evaluate(() => [...window.__puzzle.state().tray].sort((x, y) => x - y));
  await a.page.reload();
  await expect(a.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('1모둠');
  await expect(a.page.locator('.pz-chips .chip', { hasText: '다솜이' }).locator('em')).toHaveText('나');
  expect(await a.page.evaluate(() => [...window.__puzzle.state().tray].sort((x, y) => x - y))).toEqual(tray);

  // D14: no student name anywhere in the database (jigsaw and every other schema the app could
  // write to), nor in the rt server's output.
  await a.page.waitForTimeout(2500); // past the server's 2-second board save
  const { rows: tables } = await sql(
    "select quote_ident(schemaname) || '.' || quote_ident(relname) as t from pg_stat_user_tables where schemaname in ('jigsaw', 'public', 'auth', 'storage')",
  );
  for (const { t } of tables) {
    const { rows } = await sql(`select coalesce(string_agg(row_to_json(dumped_row)::text, ' '), '') as dump from ${t} dumped_row`);
    for (const name of ['다솜이', '보람찬', '한결이']) expect(rows[0].dump, `${t} has ${name}`).not.toContain(name);
  }
  const log = readFileSync(RT_LOG_FILE, 'utf8');
  expect(log, 'rt 서버 출력 파일: pnpm test:e2e 가 rt 서버를 띄우게 하세요').toContain('에서 시작');
  for (const name of ['다솜이', '보람찬', '한결이']) expect(log).not.toContain(name);
  for (const student of [a, b, c]) {
    const { token } = (await savedEntry(student.page, cls.code)) ?? {};
    if (token) expect(log).not.toContain(token);
  }

  // No Supabase request from a student page: the rt server answers everything.
  for (const student of [a, b, c]) expect(supabaseHosts(student.hosts)).toEqual([]);

  // The class ends: students are told, and the device forgets the class and the name.
  await control.end();
  await expect(b.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible();
  expect(await savedEntry(b.page, cls.code)).toBeNull();
  await b.page.screenshot({ path: testInfo.outputPath('student-5-ended.png') });
  await expect(a.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible();
  expect(await savedEntry(a.page, cls.code)).toBeNull();

  for (const student of [a, b, c]) {
    expect(student.errors).toEqual([]);
    await student.context.close();
  }
  control.close();
});

test('a student can fix the name while waiting, and comes back to it from home', async ({ browser }, testInfo) => {
  const cls = await openClass({ pieces: 12, groups: 2 });
  const control = await classControl(cls);
  const s = await studentContext(browser, testInfo, '민쥰');
  await s.page.goto(`/join?code=${cls.code}`);
  await s.page.getByLabel('내 이름').fill('민쥰');
  await s.page.getByRole('button', { name: '다음' }).click();
  await expect(s.page.getByText('민쥰, 잘 들어왔어요!')).toBeVisible();
  const memberId = await control.memberId('민쥰');
  await s.page.getByRole('button', { name: '이름 고치기' }).click();
  await expect(s.page.getByRole('heading', { level: 1, name: '이름을 고쳐 주세요' })).toBeVisible();
  await s.page.getByLabel('내 이름').fill('민준');
  await s.page.getByRole('button', { name: '바꾸기' }).click();
  await expect(s.page.getByText('민준, 잘 들어왔어요!')).toBeVisible();
  expect((await savedEntry(s.page, cls.code)).name).toBe('민준');
  // The teacher sees the new name on the same student.
  expect(await control.memberId('민준')).toBe(memberId);

  // Home shows a way back into the same class.
  await s.page.goto('/');
  const resume = s.page.getByRole('link', { name: /이어서 하기/ });
  await expect(resume).toContainText('민준');
  await expectNoHorizontalOverflow(s.page);
  await s.page.screenshot({ path: testInfo.outputPath('home-resume.png') });
  await resume.click();
  await expect(s.page.getByText('민준, 잘 들어왔어요!')).toBeVisible();
  expect(s.errors).toEqual([]);
  await s.context.close();
  control.close();
});

test('a saved class that is gone: reopening says it ended and forgets it', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'one size is enough');
  const s = await studentContext(browser, testInfo, '지난반');
  // A token the rt server does not know (its class ended while this device was away).
  const code = '987654';
  await s.page.goto('/');
  await s.page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [savedKeyOf(code), JSON.stringify({ v: 2, name: '지난반', code, token: 'A'.repeat(43), savedAt: Date.now() })],
  );
  await s.page.reload();
  await expect(s.page.getByRole('link', { name: /이어서 하기/ })).toContainText('지난반');
  await s.page.getByRole('link', { name: /이어서 하기/ }).click();
  await expect(s.page.getByRole('heading', { level: 1, name: '이 수업은 끝났어요' })).toBeVisible();
  expect(await savedEntry(s.page, code)).toBeNull();
  await expectNoHorizontalOverflow(s.page);
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('too many wrong codes from this address: the student is asked to wait', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-360', 'one size is enough');
  const s = await studentContext(browser, testInfo, '기다림');
  // The real block would stop every test of this run (one address): the answer is faked here.
  await s.page.route('**/api/join', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': ORIGIN },
      body: JSON.stringify({ ok: false, error: 'too_many_attempts' }),
    }),
  );
  await s.page.goto('/join?code=123456');
  await s.page.getByLabel('내 이름').fill('기다림');
  await s.page.getByRole('button', { name: '다음' }).click();
  await expect(s.page.getByRole('alert')).toHaveText('코드를 여러 번 틀렸어요. 잠시 뒤에 다시 입력해 주세요.');
  await expectNoHorizontalOverflow(s.page);
  await s.page.screenshot({ path: testInfo.outputPath('student-1-too-many.png') });
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('on the hosted site, students join through the rt server at rt.gyosil.app', async ({ page, baseURL }, testInfo) => {
  test.skip(!['desktop-1440', 'phone-360'].includes(testInfo.project.name), 'one wide and one phone screen');
  // Nothing reaches the hosted rt server: its answer is a stand-in (support/production.js).
  const { unexpected } = await asHostedSite(page, baseURL);
  const joins = [];
  await page.route(`${HOSTED_RT}/api/join`, (route) => {
    joins.push({ origin: route.request().headers().origin, body: route.request().postDataJSON() });
    return route.fulfill(rtAnswer({ ok: false, error: 'invalid_code' }, 404));
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}/play`);
  await expect(page.getByRole('heading', { level: 1, name: '들어간 수업이 없어요' })).toBeVisible();
  await page.goto(`${SITE}/join?code=123456`);
  await page.getByLabel('내 이름').fill('운영반');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByRole('alert')).toHaveText('코드를 다시 확인해 주세요');
  expect(joins).toEqual([{ origin: SITE, body: { code: '123456', name: '운영반' } }]);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('student-hosted-join.png'), fullPage: true });
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
