import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { pickConfig } from '../../public/js/config.js';
import { DB_SCHEMA } from '../../public/js/supabase-names.js';
import { closeSql, deleteSessions, signInPage, sql, teacherSession } from './support/teacher.js';
import { dragFromTray, expectNoHorizontalOverflow, frameOrigin, makeInput, placeAll, puzzleState, showFrame } from './support/puzzle.js';

// T12: 모둠 한눈에 보기 and 수업 끝내기 (D10, D11, D14) against the local stack. The teacher
// and the students who play are browser contexts; the bigger classes for the look and the
// performance checks have Node students (anonymous accounts that join and track Presence).

const LOCAL = pickConfig('localhost');
const NODE_CLIENT = {
  db: { schema: DB_SCHEMA },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};
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

async function createClass({ pieces = 12, groups = 2, key = 'sea', aspect = 1800 / 1200, hints = {} } = {}) {
  const { client } = await teacherSession();
  const { data, error } = await client.rpc('create_session', {
    p_piece_count: pieces,
    p_group_count: groups,
    p_builtin_key: key,
    p_aspect: aspect,
    ...hints,
  });
  if (error) throw error;
  createdSessions.push(data.id);
  const { rows } = await sql('select id from jigsaw.groups where session_id = $1 order by number', [data.id]);
  return { ...data, client, groupIds: rows.map((r) => Number(r.id)) };
}

async function rpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.code} ${error.message}`);
  return data;
}

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

async function joinStudent(browser, testInfo, code, name) {
  const context = await browser.newContext({ ...testInfo.project.use });
  await watchCsp(context);
  const page = await context.newPage();
  const errors = watch(page, name, testInfo);
  await page.goto(`/join?code=${code}`);
  await page.getByLabel('내 이름').fill(name);
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jigsaw-student')));
  const { rows } = await sql('select user_id from jigsaw.members where id = $1', [saved.memberId]);
  return { name, context, page, errors, memberId: saved.memberId, userId: rows[0].user_id, input: makeInput(page, testInfo) };
}

// A student without a browser: joins and shows up in Presence with a name (like student/live.js).
async function nodeStudent(code, name, { present = true } = {}) {
  const client = createClient(LOCAL.supabaseUrl, LOCAL.publishableKey, NODE_CLIENT);
  nodeClients.push(client);
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  const joined = await rpc(client, 'join_session', { p_code: code });
  await client.realtime.setAuth(data.session.access_token);
  const student = {
    client,
    name,
    memberId: joined.member_id,
    userId: data.user.id,
    sessionId: joined.session_id,
    channel: null,
    async enter() {
      const channel = client.channel(`jigsaw:session:${joined.session_id}`, { config: { private: true, presence: { key: data.user.id } } });
      await new Promise((resolve) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') channel.track({ member: joined.member_id, name }).then(resolve);
        });
      });
      this.channel = channel;
    },
    async leave() {
      if (this.channel) await client.removeChannel(this.channel);
      this.channel = null;
    },
  };
  if (present) await student.enter();
  return student;
}

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

// Board state written straight into the database: `locked` pieces in the frame, `loose`
// pieces scattered around it, the rest stays in the trays. Positions are picture origins.
async function seedBoard(groupId, { cols, rows, aspect }, { locked, loose, seed = 1 }) {
  const width = cols * 100;
  const height = width / aspect;
  const boardW = width * Math.sqrt(3);
  const boardH = height * Math.sqrt(3);
  const ox = (boardW - width) / 2;
  const oy = (boardH - height) / 2;
  const ph = height / rows;
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const { rows: pieces } = await sql('select col, "row", cluster_id from jigsaw.pieces where group_id = $1 order by "row", col', [groupId]);
  const order = pieces.map((p, i) => ({ ...p, k: (i * 7919 + seed * 31) % pieces.length })).sort((a, b) => a.k - b.k);
  for (const [i, p] of order.entries()) {
    if (i < locked) {
      await sql('update jigsaw.clusters set x = $2, y = $3, locked = true where id = $1', [p.cluster_id, ox, oy]);
    } else if (i < locked + loose) {
      // Somewhere on the board outside the frame, picture origin so the piece cell lands there.
      let cx;
      let cy;
      do {
        cx = 20 + rand() * (boardW - 140);
        cy = 20 + rand() * (boardH - ph - 40);
      } while (cx > ox - 110 && cx < ox + width + 10 && cy > oy - ph - 10 && cy < oy + height + 10);
      await sql('update jigsaw.clusters set x = $2, y = $3, z = $4 where id = $1', [p.cluster_id, cx - p.col * 100, cy - p.row * ph, i]);
    } else continue;
    await sql('update jigsaw.pieces set on_board = true, owner_id = null where group_id = $1 and col = $2 and "row" = $3', [groupId, p.col, p.row]);
  }
}

// ---------- the class from start to end ----------

test('D10·D11·D14: overview refreshes about every 3 s, shows 완성, big view, late student, then 수업 끝내기 cleans up', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const session = await createClass({ pieces: 12, groups: 2 });
  const [g1, g2] = session.groupIds;
  const A = await joinStudent(browser, testInfo, session.code, '민준');
  const B = await joinStudent(browser, testInfo, session.code, '서연');
  const C = await joinStudent(browser, testInfo, session.code, '지호');
  for (const [s, g] of [
    [A, g1],
    [B, g1],
    [C, g2],
  ]) {
    await rpc(session.client, 'assign_member', { p_member: s.memberId, p_group: g });
  }

  // The lobby turns into the overview when the teacher starts.
  const teacher = await openTeacher(browser, testInfo, session.id);
  const { page } = teacher;
  await expect(page.locator('.t-group .t-chip', { hasText: '지호' })).toBeVisible();
  await page.getByRole('button', { name: '시작하기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /모둠 한눈에 보기/ })).toBeAttached();
  await expect(page.locator('.t-ov-card')).toHaveCount(2);
  await expect(page).toHaveTitle(/모둠 한눈에 보기/);
  for (const s of [A, B, C]) await expect(s.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
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
  await expect.poll(() => boardsDrawn(page)).toBe(true);
  await expectNoHorizontalOverflow(page);

  // Refresh: about every 3 seconds, and nothing while the page is hidden.
  const reads = [];
  page.on('request', (r) => r.url().includes('/rpc/session_overview') && reads.push(Date.now()));
  await page.waitForTimeout(7_500);
  const gaps = reads.slice(1).map((t, i) => t - reads[i]);
  testInfo.annotations.push({ type: 'overview read gaps (ms)', description: JSON.stringify(gaps) });
  expect(gaps.length).toBeGreaterThanOrEqual(1);
  for (const gap of gaps) {
    expect(gap).toBeGreaterThan(2_800);
    expect(gap).toBeLessThan(4_000);
  }
  const setVisibility = (value) =>
    page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
  await setVisibility('hidden');
  const hiddenAt = reads.length;
  await page.waitForTimeout(4_000);
  expect(reads.length).toBe(hiddenAt);
  await setVisibility('visible');
  await expect.poll(() => reads.length).toBeGreaterThan(hiddenAt);

  // A student puts a piece in its place: the teacher's board and progress follow within ~3 s.
  const before = await page.locator('.t-ov-card canvas').first().evaluate((c) => c.toDataURL());
  await showFrame(A.page, A.input);
  const { ox, oy } = await frameOrigin(A.page);
  const piece = (await puzzleState(A.page)).tray[0];
  await dragFromTray(A.page, A.input, piece, ox, oy);
  await expect.poll(async () => (await sql('select count(*)::int as n from jigsaw.clusters where group_id = $1 and locked', [g1])).rows[0].n).toBe(1);
  const lockedAt = Date.now();
  await expect(progress(page, 1)).toHaveAttribute('aria-valuetext', '12조각 중 1조각 (8%)', { timeout: 5_000 });
  const seenAfter = Date.now() - lockedAt;
  testInfo.annotations.push({ type: 'piece locked -> teacher progress (ms)', description: String(seenAfter) });
  expect(seenAfter).toBeLessThan(4_500);
  await expect(card(page, 1).locator('.t-ov-pct')).toHaveText('8%');
  await expect.poll(() => page.locator('.t-ov-card canvas').first().evaluate((c) => c.toDataURL())).not.toBe(before);
  expect(await page.evaluate(() => window.__overview.model().groups[0].clusters.filter((c) => c.locked).length)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('overview-1-progress.png') });

  // Group 2 finishes: 완성 with the time taken, everywhere on the teacher's screen (D10).
  await placeAll(C.page, C.input);
  await expect(C.page.getByRole('heading', { level: 1, name: '2모둠 완성!' })).toBeVisible({ timeout: 15_000 });
  await expect(card(page, 2)).toHaveClass(/is-done/, { timeout: 5_000 });
  await expect(card(page, 2).locator('.t-ov-pct')).toHaveText('완성');
  await expect(card(page, 2).locator('.t-ov-badge')).toHaveText(/^완성 · (\d+분 )?\d+초$|^완성 · \d+분$/);
  await expect(progress(page, 2)).toHaveAttribute('aria-valuenow', '100');
  await expect(page.locator('.t-ov-done')).toHaveText('완성 1 / 2모둠');
  await expect(page.locator('.t-ov-avg')).toHaveText('평균 진행률 54%'); // (8 + 100) / 2
  await expect(page.locator('[aria-live="polite"]', { hasText: '2모둠 완성했어요!' })).toBeAttached();
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
  await expect(codeBox.locator('.t-join-code')).toContainText(`${session.code.slice(0, 3)} ${session.code.slice(3)}`);
  await expect(codeBox.locator('.t-join-qr svg')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('overview-4-code.png') });
  await codeBox.getByRole('button', { name: '닫기' }).click();

  // A late student: shown as without a group, placed with the keyboard in 모둠 편성 (T9 way).
  const D = await joinStudent(browser, testInfo, session.code, '유나');
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
  await expect(D.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(D.page.getByRole('heading', { level: 1 })).toHaveText('1모둠');
  await expect(card(page, 1).locator('.t-ov-mates .chip', { hasText: '유나' })).toBeVisible();
  await expect(page.locator('.t-ov-late')).toBeHidden();

  // A student who left: 잠시 나감 with the time away.
  await B.context.close();
  await sql("update jigsaw.members set last_seen = now() - interval '42 seconds' where id = $1", [B.memberId]);
  await expect(card(page, 1).locator('.chip.off', { hasText: '서연' }).locator('em')).toHaveText(/^잠시 나감 0:4\d$/, { timeout: 8_000 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('overview-6-away.png'), fullPage: true });

  // 수업 끝내기: asks first, then students see the end and the class data about them is gone (D14).
  await page.getByRole('button', { name: '수업 끝내기' }).click();
  const endDialog = page.getByRole('dialog', { name: '수업을 끝낼까요?' });
  await expect(endDialog).toBeVisible();
  await endDialog.getByRole('button', { name: '취소' }).click();
  expect((await sql('select status from jigsaw.sessions where id = $1', [session.id])).rows[0].status).toBe('playing');
  await page.getByRole('button', { name: '수업 끝내기' }).click();
  await endDialog.getByRole('button', { name: '수업 끝내기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '수업을 끝냈어요' })).toBeVisible();
  await expect(page.locator('.t-empty .sub')).toContainText('완성한 모둠은 1 / 2모둠이에요.');
  for (const s of [A, C, D]) await expect(s.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible();
  expect((await sql('select status from jigsaw.sessions where id = $1', [session.id])).rows[0].status).toBe('ended');
  expect((await sql('select count(*)::int as n from jigsaw.members where session_id = $1', [session.id])).rows[0].n).toBe(0);
  const uids = [A, B, C, D].map((s) => s.userId);
  expect((await sql('select count(*)::int as n from auth.users where id = any($1::uuid[])', [uids])).rows[0].n).toBe(0);
  // No student name anywhere in the database.
  const { rows: tables } = await sql("select schemaname || '.' || relname as t from pg_stat_user_tables where schemaname in ('jigsaw', 'jigsaw_private')");
  for (const table of [...tables.map((r) => r.t), 'auth.users', 'realtime.messages']) {
    const { rows } = await sql(`select coalesce(string_agg(row_to_json(t)::text, ' '), '') as dump from ${table} t`);
    for (const s of [A, B, C, D]) expect(rows[0].dump, `${table} has ${s.name}`).not.toContain(s.name);
  }
  await page.screenshot({ path: testInfo.outputPath('overview-7-ended.png') });

  expect(await violations(page)).toEqual([]);
  expect(teacher.errors).toEqual([]);
  for (const s of [A, C, D]) {
    expect(await violations(s.page)).toEqual([]);
    expect(s.errors).toEqual([]);
    await s.context.close();
  }
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

async function fullClass({ pieces, perGroup, progress }) {
  const session = await createClass({ pieces, groups: 6 });
  const students = [];
  for (const [g, groupId] of session.groupIds.entries()) {
    for (let k = 0; k < perGroup; k++) {
      const away = g === 1 && k === 1; // 2모둠 도윤 left a while ago
      const s = await nodeStudent(session.code, NAMES[g][k], { present: !away });
      await rpc(session.client, 'assign_member', { p_member: s.memberId, p_group: groupId });
      students.push({ ...s, away });
    }
  }
  await rpc(session.client, 'start_session', { p_session: session.id });
  const { rows } = await sql('select cols, rows, aspect from jigsaw.sessions where id = $1', [session.id]);
  for (const [g, groupId] of session.groupIds.entries()) await seedBoard(groupId, rows[0], { ...progress[g], seed: g + 3 });
  const total = rows[0].cols * rows[0].rows;
  const done = progress.findIndex((p) => p.locked === total);
  if (done >= 0) await sql('update jigsaw.groups set completed_at = now() where id = $1', [session.groupIds[done]]);
  for (const s of students.filter((x) => x.away)) {
    await sql("update jigsaw.members set last_seen = now() - interval '42 seconds' where id = $1", [s.memberId]);
  }
  return { session, students, grid: rows[0] };
}

test('the overview looks like the mockup: 6 groups on a 1920 x 1080 whiteboard and every screen size', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'sizes are set in the test');
  test.setTimeout(180_000);
  const { session, students } = await fullClass({
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
  const away = students.find((x) => x.away);
  await sql("update jigsaw.sessions set started_at = now() - interval '12 minutes 34 seconds' where id = $1", [session.id]);
  await sql("update jigsaw.groups set completed_at = now() - interval '3 minutes 22 seconds' where session_id = $1 and number = 3", [session.id]);
  const sizes = [
    { name: 'whiteboard-1920', viewport: { width: 1920, height: 1080 } },
    { name: 'desktop-1440', viewport: { width: 1440, height: 900 } },
    { name: 'tablet-1024', viewport: { width: 1024, height: 768 } },
    { name: 'phone-390', viewport: { width: 390, height: 844 } },
    { name: 'phone-360', viewport: { width: 360, height: 780 } },
  ];
  for (const size of sizes) {
    const teacher = await openTeacher(browser, testInfo, session.id, size.viewport);
    const { page } = teacher;
    await expect(page.locator('.t-ov-card')).toHaveCount(6);
    await expect(card(page, 3)).toHaveClass(/is-done/);
    await expect(card(page, 3).locator('.t-ov-badge')).toHaveText('완성 · 9분 12초');
    await expect.poll(() => badgeCoversNothing(page, card(page, 3)), { message: `badge over the picture (${size.name})` }).toBe(true);
    await expect(page.locator('.t-ov-done')).toHaveText('완성 1 / 6모둠');
    await expect(page.locator('.t-ov-avg')).toHaveText('평균 진행률 57%'); // 62 37 100 16 50 75
    // 도윤 was here when the page opened, then left: the name stays, with the time away.
    await away.enter();
    await expect(card(page, 2).locator('.chip:not(.off)', { hasText: '도윤' })).toBeVisible();
    await away.leave();
    await sql("update jigsaw.members set last_seen = now() - interval '42 seconds' where id = $1", [away.memberId]);
    await expect(card(page, 2).locator('.chip.off', { hasText: '도윤' })).toContainText(/잠시 나감 0:4\d/, { timeout: 8_000 });
    await expect(card(page, 1).locator('.chip', { hasText: '민준' })).toBeVisible();
    await expect(page.locator('.t-ov-clock')).toHaveText(/^1[23]:\d\d$/);
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
  const { session } = await fullClass({
    pieces: 12,
    perGroup: 1,
    progress: Array.from({ length: 6 }, (_, g) => (g === 0 ? { locked: 12, loose: 0 } : { locked: g, loose: 3 })),
  });
  const context = await browser.newContext({ ...testInfo.project.use, reducedMotion: 'reduce' });
  await signInPage(context);
  const page = await context.newPage();
  await page.goto(`/teacher/sessions/${session.id}`);
  await expect(card(page, 1)).toHaveClass(/is-done/);
  const styles = await page.evaluate(() => ({
    bar: getComputedStyle(document.querySelector('.t-ov-prog i')).transitionDuration,
    badge: getComputedStyle(document.querySelector('.t-ov-badge')).animationName,
  }));
  expect(styles).toEqual({ bar: '0s', badge: 'none' });
  await context.close();
});

// ---------- a class with the teacher's own picture ----------

test("a class with the teacher's own picture: the boards cut it from the private bucket", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough');
  test.setTimeout(120_000);
  const { client } = await teacherSession();
  const { data: image, error: rowError } = await client.from('images').insert({ width: 1800, height: 1200 }).select().single();
  if (rowError) throw rowError;
  try {
    const bytes = readFileSync(new URL('../../public/images/builtin/sea.webp', import.meta.url));
    const { error: uploadError } = await client.storage.from('jigsaw-images').upload(image.path, bytes, { contentType: 'image/webp' });
    if (uploadError) throw uploadError;
    const session = await createClass({ pieces: 12, groups: 2, key: null, aspect: null, hints: { p_image_id: image.id, p_hint_underlay: true } });
    for (const [g, groupId] of session.groupIds.entries()) {
      const s = await nodeStudent(session.code, NAMES[g][0]);
      await rpc(session.client, 'assign_member', { p_member: s.memberId, p_group: groupId });
    }
    await rpc(session.client, 'start_session', { p_session: session.id });
    const grid = (await sql('select cols, rows, aspect from jigsaw.sessions where id = $1', [session.id])).rows[0];
    await seedBoard(session.groupIds[0], grid, { locked: 5, loose: 4 });

    const context = await browser.newContext({ ...testInfo.project.use });
    await watchCsp(context);
    await signInPage(context);
    const page = await context.newPage();
    const errors = watch(page, 'teacher', testInfo);
    const downloads = [];
    page.on('request', (r) => r.url().includes(`/storage/v1/object/jigsaw-images/${image.path}`) && downloads.push(r.url()));
    await page.goto(`/teacher/sessions/${session.id}`);
    await expect(page.locator('.t-ov-card')).toHaveCount(2);
    await expect(page.locator('.pill.t-summary')).toHaveText('내 그림 · 12조각');
    await expect.poll(() => boardsDrawn(page)).toBe(true);
    expect(downloads.length).toBe(1);
    await expect(progress(page, 1)).toHaveAttribute('aria-valuetext', '12조각 중 5조각 (41%)');
    await page.screenshot({ path: testInfo.outputPath('overview-own-picture.png') });
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await client.storage.from('jigsaw-images').remove([image.path]);
    await sql('delete from jigsaw.sessions where image_id = $1', [image.id]);
    await client.from('images').delete().eq('id', image.id);
  }
});

// ---------- performance on a slow whiteboard PC ----------

test('6 groups x 70 pieces: refreshing the small boards has no long task on a 4x slower CPU', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough (1920 whiteboard)');
  test.setTimeout(240_000);
  const { session, grid } = await fullClass({
    pieces: 70,
    perGroup: 1,
    progress: Array.from({ length: 6 }, (_, g) => ({ locked: 10 + g * 5, loose: 30 })),
  });
  const teacher = await openTeacher(browser, testInfo, session.id, { width: 1920, height: 1080 });
  const { page } = teacher;
  await expect(page.locator('.t-ov-card')).toHaveCount(6);
  await expect.poll(() => boardsDrawn(page), { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(3_500);

  const cdp = await teacher.context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
    }).observe({ type: 'longtask' });
  });
  // Four refreshes in which every group moved pieces and locked more (all boards redraw and slide).
  const reads = [];
  page.on('response', (r) => r.url().includes('/rpc/session_overview') && reads.push(Date.now()));
  const width = grid.cols * 100;
  for (let round = 0; round < 4; round++) {
    for (const groupId of session.groupIds) {
      await sql(
        `update jigsaw.clusters c set x = c.x + 37 * sin(c.id + $2), y = c.y + 23 * cos(c.id + $2)
           where c.group_id = $1 and not c.locked
             and exists (select 1 from jigsaw.pieces p where p.cluster_id = c.id and p.on_board)`,
        [groupId, round],
      );
      await sql(
        `update jigsaw.clusters c set locked = true,
              x = ($2::float8 * sqrt(3::float8) - $2) / 2, y = ($2::float8 / $3 * sqrt(3::float8) - $2::float8 / $3) / 2
           where c.id in (select p.cluster_id from jigsaw.pieces p join jigsaw.clusters k on k.id = p.cluster_id
                          where p.group_id = $1 and p.on_board and not k.locked order by p.cluster_id limit 2)`,
        [groupId, width, grid.aspect],
      );
    }
    const seen = reads.length;
    await expect.poll(() => reads.length, { timeout: 10_000 }).toBeGreaterThan(seen);
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
