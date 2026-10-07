import { expect, test } from '@playwright/test';
import { deleteLegacySessions as deleteSessions, legacyTeacher as teacherSession } from './support/legacy.js';
import { closeSql, sql } from './support/teacher.js';

// T9: students join with a code and a name, wait, get their group and start (D3, D4, D14).
// Several browser contexts play the students against the local stack. The student screens
// still use the old structure (Supabase) until T22, so the teacher's moves are made from Node
// (RPCs); the teacher's lobby itself runs on the rt server since T21 (teacher.spec.js).
// Every test ends its session and removes it, with the anonymous accounts it created.

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

async function openSession(groupCount = 4) {
  const { client } = await teacherSession();
  const { data, error } = await client.rpc('create_session', {
    p_piece_count: 24,
    p_group_count: groupCount,
    p_builtin_key: 'sea',
    p_aspect: 1800 / 1200,
  });
  if (error) throw error;
  createdSessions.push(data.id);
  const { rows } = await sql('select id, number from public.groups where session_id = $1 order by number', [data.id]);
  return { ...data, groups: rows.map((r) => ({ id: Number(r.id), number: r.number })), client };
}

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function expectNoHorizontalOverflow(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

async function newStudent(browser, testInfo) {
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  return { context, page, errors: trackErrors(page) };
}

const savedEntry = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('jigsaw-student') ?? 'null'));


test('D3·D4·D14: students join by code or QR, get their groups and start', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const session = await openSession(4);
  const rpc = async (fn, args) => {
    const { data, error } = await session.client.rpc(fn, args);
    if (error) throw error;
    return data;
  };
  const memberOf = async (student) => (await savedEntry(student.page)).memberId;

  // Student A types the code on the home page (six cells).
  const a = await newStudent(browser, testInfo);
  await a.page.goto('/');
  const codeInput = a.page.getByLabel('수업 코드 6자리');
  await codeInput.fill(session.code.slice(0, 3));
  await expect(a.page.locator('.code-cells span.is-filled')).toHaveCount(3);
  await expect(a.page.locator('.code-cells span.is-cur')).toHaveCount(1);
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-1-code.png') });
  await codeInput.fill(session.code);
  await a.page.getByRole('button', { name: '들어가기' }).click();
  await expect(a.page.getByRole('heading', { level: 1, name: '이름을 알려 주세요' })).toBeVisible();
  await expect(a.page.locator('.st-topnav .pill')).toHaveText(`수업 ${session.code.slice(0, 3)} ${session.code.slice(3)}`);
  await expect(a.page.getByText('이름은 저장하지 않아요.')).toBeVisible();
  await a.page.getByLabel('내 이름').fill('  다솜이 ');
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-2-name.png') });
  await a.page.getByRole('button', { name: '다음' }).click();
  await expect(a.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();

  // Student B scans the QR: the code is already in the address, so only the name is asked.
  const b = await newStudent(browser, testInfo);
  await b.page.goto(`/join?code=${session.code}`);
  await expect(b.page.getByRole('heading', { level: 1, name: '이름을 알려 주세요' })).toBeVisible();
  await b.page.getByLabel('내 이름').fill('보람찬');
  await b.page.getByLabel('내 이름').press('Enter');
  await expect(b.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();

  // Student C mistypes the code: told to check it, keeps the name, goes straight in after fixing it.
  const wrong = session.code === '000000' ? '000001' : '000000';
  const c = await newStudent(browser, testInfo);
  await c.page.goto(`/join?code=${wrong}`);
  await c.page.getByLabel('내 이름').fill('한결이');
  await c.page.getByRole('button', { name: '다음' }).click();
  await expect(c.page.getByRole('alert')).toHaveText('코드를 다시 확인해 주세요');
  await expect(c.page.getByLabel('수업 코드 6자리')).toHaveValue(wrong);
  await expectNoHorizontalOverflow(c.page);
  await c.page.screenshot({ path: testInfo.outputPath('student-1-wrong-code.png') });
  await c.page.getByLabel('수업 코드 6자리').fill(session.code);
  await c.page.getByRole('button', { name: '들어가기' }).click();
  await expect(c.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  await expect(c.page.getByText('한결이, 잘 들어왔어요!')).toBeVisible();
  await expectNoHorizontalOverflow(c.page);
  await c.page.screenshot({ path: testInfo.outputPath('student-3-waiting.png') });

  // 무작위로 나누기 (from Node): everyone gets a group, and each student screen shows it.
  await rpc('randomize_groups', { p_session: session.id });
  for (const [student, name] of [
    [a, '다솜이'],
    [b, '보람찬'],
    [c, '한결이'],
  ]) {
    const { memberId } = await savedEntry(student.page);
    const { rows } = await sql(
      'select g.number from public.members m join public.groups g on g.id = m.group_id where m.id = $1',
      [memberId],
    );
    await expect(student.page.getByRole('heading', { level: 1 })).toHaveText(`${name}, ${rows[0].number}모둠이에요!`);
    await expect(student.page.locator('.st-mate.is-me')).toContainText(name);
  }

  // Moves: 다솜이 into 1모둠, 보람찬 into another group, 한결이 back to no group.
  const g = (number) => session.groups.find((x) => x.number === number).id;
  await rpc('assign_member', { p_member: await memberOf(a), p_group: g(1) });
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('다솜이, 1모둠이에요!');
  const target = 2;
  await rpc('assign_member', { p_member: await memberOf(b), p_group: g(target) });
  await expect(b.page.getByRole('heading', { level: 1 })).toHaveText(`보람찬, ${target}모둠이에요!`);
  await rpc('assign_member', { p_member: await memberOf(c), p_group: null });
  await expect(c.page.getByRole('heading', { level: 1 })).toHaveText('선생님이 모둠을 정하고 있어요');

  // Same group as A: put C into 1모둠 to check groupmates on both screens.
  await rpc('assign_member', { p_member: await memberOf(c), p_group: g(1) });
  await expect(a.page.locator('.st-mate', { hasText: '한결이' })).toBeVisible();
  await expect(c.page.locator('.st-mate', { hasText: '다솜이' })).toBeVisible();
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-3-waiting-group.png') });

  // 시작하기 → every student gets their own group's puzzle (T11), on /play (not the demo).
  await rpc('start_session', { p_session: session.id });
  for (const [student, number] of [
    [a, 1],
    [b, target],
    [c, 1],
  ]) {
    await expect(student.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
    await expect(student.page.getByRole('heading', { level: 1 })).toHaveText(`${number}모둠`);
    await expect(student.page).toHaveURL(/\/play$/);
    expect(await student.page.evaluate(() => window.__puzzleDemo)).toBeUndefined();
  }
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-4-started.png') });
  expect((await sql('select status from public.sessions where id = $1', [session.id])).rows[0].status).toBe('playing');

  // Same device again: back to the same name, group and tray without asking.
  const tray = await a.page.evaluate(() => [...window.__puzzle.state().tray].sort((x, y) => x - y));
  await a.page.reload();
  await expect(a.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('1모둠');
  await expect(a.page.locator('.pz-chips .chip', { hasText: '다솜이' }).locator('em')).toHaveText('나');
  expect(await a.page.evaluate(() => [...window.__puzzle.state().tray].sort((x, y) => x - y))).toEqual(tray);

  // D14: no student name anywhere in the database.
  const dumps = await sql(`
    select 'public.' || relname as t from pg_stat_user_tables where schemaname = 'public'
  `);
  const tables = [...dumps.rows.map((r) => r.t), 'auth.users', 'auth.identities', 'realtime.messages', 'private.join_failures'];
  for (const table of tables) {
    const { rows } = await sql(`select coalesce(string_agg(row_to_json(t)::text, ' '), '') as dump from ${table} t`);
    for (const name of ['다솜이', '보람찬', '한결이']) expect(rows[0].dump, `${table} has ${name}`).not.toContain(name);
  }

  // The class ends: students are told, and the device forgets the class and the name.
  await session.client.rpc('end_session', { p_session: session.id });
  await expect(b.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible();
  expect(await savedEntry(b.page)).toBeNull();
  await b.page.screenshot({ path: testInfo.outputPath('student-5-ended.png') });

  for (const student of [a, b, c]) {
    expect(student.errors).toEqual([]);
    await student.context.close();
  }
});

test('a student can fix the name while waiting, and comes back to it from home', async ({ browser }, testInfo) => {
  const session = await openSession(2);
  const s = await newStudent(browser, testInfo);
  await s.page.goto(`/join?code=${session.code}`);
  await s.page.getByLabel('내 이름').fill('민쥰');
  await s.page.getByRole('button', { name: '다음' }).click();
  await expect(s.page.getByText('민쥰, 잘 들어왔어요!')).toBeVisible();
  await s.page.getByRole('button', { name: '이름 고치기' }).click();
  await expect(s.page.getByRole('heading', { level: 1, name: '이름을 고쳐 주세요' })).toBeVisible();
  await s.page.getByLabel('내 이름').fill('민준');
  await s.page.getByRole('button', { name: '바꾸기' }).click();
  await expect(s.page.getByText('민준, 잘 들어왔어요!')).toBeVisible();
  expect((await savedEntry(s.page)).name).toBe('민준');

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
});

