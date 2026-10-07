import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { pickConfig } from '../../public/js/config.js';
import { DB_SCHEMA } from '../../public/js/supabase-names.js';
import { closeSql, deleteSessions, signInPage, sql, teacherSession } from './support/teacher.js';

// T9: students join with a code and a name, wait, and the teacher groups them and starts
// (D3, D4, D14). Several browser contexts play the students against the local stack.
// Every test ends its session and removes it, with the anonymous accounts it created.

const LOCAL = pickConfig('localhost');
const createdSessions = [];
const nodeClients = [];

test.afterAll(async () => {
  for (const client of nodeClients.splice(0)) await client.removeAllChannels();
  if (createdSessions.length) {
    await sql(
      `delete from auth.users where is_anonymous and id in
         (select user_id from jigsaw.members where session_id = any($1::bigint[]))`,
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
  const { rows } = await sql('select id, number from jigsaw.groups where session_id = $1 order by number', [data.id]);
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

// Real touch input (CDP), which Chromium turns into pointer events like a tablet would.
async function touchDrag(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) });
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function mouseDrag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 8, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

test('D3·D4·D14: students join by code or QR, the teacher sees names live, groups them and starts', async ({
  browser,
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const touch = Boolean(testInfo.project.use.hasTouch);
  const session = await openSession(4);
  const teacherErrors = trackErrors(page);
  await signInPage(context);
  await page.goto(`/teacher/sessions/${session.id}`);
  await expect(page.locator('.t-join-wait')).toHaveText('학생들이 들어오기를 기다리고 있어요');
  await expect(page.getByRole('button', { name: '시작하기' })).toBeDisabled();
  await expect(page.locator('#t-start-hint')).toHaveText('학생이 들어오면 시작할 수 있어요.');

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
  // D3: from pressing 다음 (sign-in, join_session, Presence) to the name in the lobby: within a second.
  const pressedA = Date.now();
  await a.page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('.t-pool .t-chip', { hasText: '다솜이' })).toBeVisible({ timeout: 1000 });
  const latencyA = Date.now() - pressedA;
  // Exactly the name: no stray "null" text from optional parts, in the text or the accessible name.
  await expect(page.locator('.t-pool .t-chip', { hasText: '다솜이' })).toHaveText('다솜이');
  await expect(page.getByRole('button', { name: '다솜이', exact: true })).toHaveCount(1);
  await expect(a.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();

  // Student B scans the QR: the code is already in the address, so only the name is asked.
  const b = await newStudent(browser, testInfo);
  await b.page.goto(`/join?code=${session.code}`);
  await expect(b.page.getByRole('heading', { level: 1, name: '이름을 알려 주세요' })).toBeVisible();
  await b.page.getByLabel('내 이름').fill('보람찬');
  const pressedB = Date.now();
  await b.page.getByLabel('내 이름').press('Enter');
  await expect(page.locator('.t-pool .t-chip', { hasText: '보람찬' })).toBeVisible({ timeout: 1000 });
  const latencyB = Date.now() - pressedB;
  await expect(b.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  testInfo.annotations.push({ type: 'name latency (ms)', description: `${latencyA}, ${latencyB}` });

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

  await expect(page.locator('.t-pool h3')).toContainText('3명');
  for (const name of ['다솜이', '보람찬', '한결이']) {
    await expect(page.locator('.t-chip', { hasText: name })).toHaveText(name);
  }
  await expect(page.locator('.t-grouping')).not.toContainText('null');
  await expect(page.locator('.t-join-wait')).toHaveText('들어온 학생 3명');
  await expect(page.locator('#t-start-hint')).toHaveText('학생을 모둠에 넣으면 시작할 수 있어요.');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-pool.png'), fullPage: true });

  // 무작위로 나누기: everyone gets a group, and each student screen shows it.
  await page.getByRole('button', { name: '무작위로 나누기' }).click();
  await expect(page.locator('.t-pool .t-empty-line')).toHaveText('모든 학생이 모둠에 들어갔어요.');
  for (const [student, name] of [
    [a, '다솜이'],
    [b, '보람찬'],
    [c, '한결이'],
  ]) {
    const { memberId } = await savedEntry(student.page);
    const { rows } = await sql(
      'select g.number from jigsaw.members m join jigsaw.groups g on g.id = m.group_id where m.id = $1',
      [memberId],
    );
    await expect(student.page.getByRole('heading', { level: 1 })).toHaveText(`${name}, ${rows[0].number}모둠이에요!`);
    await expect(student.page.locator('.st-mate.is-me')).toContainText(name);
  }

  // Drag A into 1모둠 (touch on touch projects, mouse otherwise).
  const chipA = page.locator('.t-chip', { hasText: '다솜이' });
  const box1 = page.locator('.t-group').nth(0);
  await box1.scrollIntoViewIfNeeded();
  await chipA.scrollIntoViewIfNeeded();
  const from = centre(await chipA.boundingBox());
  const toBox = await box1.boundingBox();
  const to = { x: toBox.x + toBox.width / 2, y: toBox.y + Math.min(toBox.height - 10, 60) };
  if (touch) await touchDrag(page, from, to);
  else await mouseDrag(page, from, to);
  await expect(box1.locator('.t-chip', { hasText: '다솜이' })).toBeVisible();
  await expect(box1.locator('.t-chip', { hasText: '다솜이' })).toHaveAttribute('aria-pressed', 'false');
  await expect(box1.locator('.t-chip', { hasText: '다솜이' })).toHaveText('다솜이');
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('다솜이, 1모둠이에요!');

  // Keyboard: pick B with Enter, place it in 2모둠 with its 여기에 놓기 button.
  const chipB = page.locator('.t-chip', { hasText: '보람찬' });
  const bInTwo = (await page.locator('.t-group').nth(1).locator('.t-chip', { hasText: '보람찬' }).count()) > 0;
  const target = bInTwo ? 3 : 2;
  await chipB.focus();
  await page.keyboard.press('Enter');
  await expect(chipB).toHaveAttribute('aria-pressed', 'true');
  const place = page.getByRole('button', { name: `보람찬을 ${target}모둠에 놓기` });
  await place.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.t-group').nth(target - 1).locator('.t-chip', { hasText: '보람찬' })).toBeVisible();
  await expect(page.locator('.t-chip', { hasText: '보람찬' })).toBeFocused();
  await expect(b.page.getByRole('heading', { level: 1 })).toHaveText(`보람찬, ${target}모둠이에요!`);

  // C back to the pool by keyboard, so the start asks first.
  await page.locator('.t-chip', { hasText: '한결이' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '한결이를 모둠에서 빼기' }).click();
  await expect(page.locator('.t-pool .t-chip', { hasText: '한결이' })).toBeVisible();
  await expect(c.page.getByRole('heading', { level: 1 })).toHaveText('선생님이 모둠을 정하고 있어요');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-grouped.png'), fullPage: true });

  // Same group as A: put C into 1모둠 to check groupmates on both screens.
  await page.locator('.t-chip', { hasText: '한결이' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '한결이를 1모둠에 놓기' }).click();
  await expect(a.page.locator('.st-mate', { hasText: '한결이' })).toBeVisible();
  await expect(c.page.locator('.st-mate', { hasText: '다솜이' })).toBeVisible();
  await expectNoHorizontalOverflow(a.page);
  await a.page.screenshot({ path: testInfo.outputPath('student-3-waiting-group.png') });

  // 시작하기 → every student gets their own group's puzzle (T11), on /play (not the demo).
  // The lobby turns into 모둠 한눈에 보기 (T12, tests/e2e/overview.spec.js).
  await page.getByRole('button', { name: '시작하기' }).click();
  await expect(page.locator('.t-ov-card')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '무작위로 나누기' })).toHaveCount(0);
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
  expect((await sql('select status from jigsaw.sessions where id = $1', [session.id])).rows[0].status).toBe('playing');

  // Same device again: back to the same name, group and tray without asking.
  const tray = await a.page.evaluate(() => [...window.__puzzle.state().tray].sort((x, y) => x - y));
  await a.page.reload();
  await expect(a.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('1모둠');
  await expect(a.page.locator('.pz-chips .chip', { hasText: '다솜이' }).locator('em')).toHaveText('나');
  expect(await a.page.evaluate(() => [...window.__puzzle.state().tray].sort((x, y) => x - y))).toEqual(tray);

  // D14: no student name anywhere in the database.
  const dumps = await sql(`
    select schemaname || '.' || relname as t from pg_stat_user_tables where schemaname in ('jigsaw', 'jigsaw_private')
  `);
  const tables = [...dumps.rows.map((r) => r.t), 'auth.users', 'auth.identities', 'realtime.messages'];
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
  expect(teacherErrors).toEqual([]);
});

test('a student can fix the name while waiting, and the teacher sees the new name', async ({ browser, page, context }, testInfo) => {
  const session = await openSession(2);
  await signInPage(context);
  await page.goto(`/teacher/sessions/${session.id}`);
  const s = await newStudent(browser, testInfo);
  await s.page.goto(`/join?code=${session.code}`);
  await s.page.getByLabel('내 이름').fill('민쥰');
  await s.page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('.t-chip', { hasText: '민쥰' })).toBeVisible();
  await s.page.getByRole('button', { name: '이름 고치기' }).click();
  await expect(s.page.getByRole('heading', { level: 1, name: '이름을 고쳐 주세요' })).toBeVisible();
  await s.page.getByLabel('내 이름').fill('민준');
  await s.page.getByRole('button', { name: '바꾸기' }).click();
  await expect(s.page.getByText('민준, 잘 들어왔어요!')).toBeVisible();
  await expect(page.locator('.t-chip', { hasText: '민준' })).toBeVisible();
  await expect(page.locator('.t-chip', { hasText: '민쥰' })).toHaveCount(0);
  await expect(page.locator('.t-chip', { hasText: '민준' })).toHaveText('민준');
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

  // The student leaves: the lobby keeps the name it saw, greyed, with '나감'.
  await s.context.close();
  const gone = page.locator('.t-chip', { hasText: '민준' });
  await expect(gone).toHaveText('민준나감', { timeout: 15000 });
  await expect(gone.locator('.t-chip-name')).toHaveText('민준');
  await expect(gone.locator('em')).toHaveText('나감');
  await expect(gone).toHaveClass(/\boff\b/);
  await expect(page.locator('.t-grouping')).not.toContainText('null');
});

test('lobby on a 1920 x 1080 whiteboard with 25 students: names, groups and buttons fit without scrolling', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one whiteboard run is enough');
  test.setTimeout(120_000);
  const session = await openSession(6);
  const names = ['민준', '서연', '지호', '유나', '하은', '도윤', '서준', '지우', '예준', '수아', '시우', '하린', '주원'];
  const more = ['지아', '은우', '채원', '건우', '윤서', '현우', '다은', '선우', '예린', '소율', '연우', '정우'];
  for (const name of [...names, ...more]) {
    const client = createClient(LOCAL.supabaseUrl, LOCAL.publishableKey, {
      db: { schema: DB_SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    nodeClients.push(client);
    const { data } = await client.auth.signInAnonymously();
    const { data: joined } = await client.rpc('join_session', { p_code: session.code });
    await client.realtime.setAuth(data.session.access_token);
    const channel = client.channel(`jigsaw:session:${session.id}`, { config: { private: true, presence: { key: data.user.id } } });
    await new Promise((resolve) => channel.subscribe((s) => s === 'SUBSCRIBED' && resolve()));
    await channel.track({ member: joined.member_id, name });
  }
  await signInPage(context);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/teacher/sessions/${session.id}`);
  await expect(page.locator('.t-join-wait')).toHaveText('들어온 학생 25명');
  await expect(page.locator('.t-chip', { hasText: '민준' })).toHaveText('민준');
  await expect(page.locator('.t-grouping')).not.toContainText('null');
  await page.getByRole('button', { name: '무작위로 나누기' }).click();
  await expect(page.locator('.t-pool .t-empty-line')).toHaveText('모든 학생이 모둠에 들어갔어요.');
  await page.getByRole('button', { name: '무작위로 나누기' }).click();
  const dialog = page.getByRole('dialog', { name: '모둠을 다시 나눌까요?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '다시 나누기' }).click();
  await expect(dialog).toHaveCount(0);

  // Read inside the page: live updates may redraw the chips between two steps.
  const fontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.t-chip')).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(19); // mockup: 19px names
  expect(await page.locator('.t-join-code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(110);
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
  const columns = await page.locator('.t-groups').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(3); // 6 groups as 3 x 2, like the mockup
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-1920-25.png') });
});
