import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  boardBox,
  cellPoint,
  dragFromTray as dragTrayPiece,
  expectNoHorizontalOverflow,
  frameOrigin,
  makeInput,
  puzzleState,
  showFrame as showPuzzleFrame,
} from './support/puzzle.js';
import { closeSql, deleteSessions, sql, teacherSession } from './support/teacher.js';

// T11: one group plays the same puzzle on several devices against the local stack
// (D5~D10). Every student is its own browser context; the teacher runs from Node.
// Times the server judges (10 s holds, 15 s / 1 min disconnects) are moved with SQL where
// waiting would only slow the test down; the 10 s hold-still release runs in real time.

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

// ---------- class set-up ----------

async function createClass(pieces, { key = 'sea', aspect = 1800 / 1200 } = {}) {
  const { client } = await teacherSession();
  const { data, error } = await client.rpc('create_session', {
    p_piece_count: pieces,
    p_group_count: 2,
    p_builtin_key: key,
    p_aspect: aspect,
  });
  if (error) throw error;
  createdSessions.push(data.id);
  const { rows } = await sql('select id from public.groups where session_id = $1 order by number', [data.id]);
  return { ...data, client, groupIds: rows.map((r) => Number(r.id)) };
}

async function joinStudent(browser, testInfo, code, name, { reducedMotion } = {}) {
  const context = await browser.newContext({ ...testInfo.project.use, reducedMotion });
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Logged (handled) errors are reported with the test, to explain a failure.
  page.on('console', (m) => m.type() === 'error' && testInfo.annotations.push({ type: `console (${name})`, description: m.text() }));
  await page.goto(`/join?code=${code}`);
  await page.getByLabel('내 이름').fill(name);
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jigsaw-student')));
  const { rows } = await sql('select user_id from public.members where id = $1', [saved.memberId]);
  return { name, context, page, errors, memberId: saved.memberId, userId: rows[0].user_id, input: makeInput(page, testInfo) };
}

// Students in group 1 (in joining order: colours 0, 1, 2...), then start.
async function startInOneGroup(session, students) {
  for (const s of students) {
    const { error } = await session.client.rpc('assign_member', { p_member: s.memberId, p_group: session.groupIds[0] });
    if (error) throw error;
  }
  const { error } = await session.client.rpc('start_session', { p_session: session.id });
  if (error) throw error;
  for (const s of students) await expect(s.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
}

// ---------- reading the screen (moves: support/puzzle.js) ----------

const state = puzzleState;
const indexOf = ([col, row], cols) => row * cols + col;
const clusterOf = (s, index) => s.clusters.find((c) => c.pieces.some((cell) => indexOf(cell, s.layout.cols) === index));
const showFrame = (student) => showPuzzleFrame(student.page, student.input);
const dragFromTray = (student, index, ox, oy) => dragTrayPiece(student.page, student.input, index, ox, oy);

// Presses on a board cluster (its first piece), moves a little and keeps holding.
async function pressCluster(student, cluster, move = [14, 10]) {
  const at = await cellPoint(student.page, cluster.x, cluster.y, cluster.pieces[0]);
  return student.input.hold([
    [at.x, at.y],
    [at.x + move[0], at.y + move[1]],
  ]);
}

// A pixel move that takes a cluster further from its place in the frame, so it never locks.
async function awayFromFrame(page, cluster, px) {
  const { ox, oy } = await frameOrigin(page);
  const sx = cluster.x - ox >= 0 ? 1 : -1;
  const sy = cluster.y - oy >= 0 ? 1 : -1;
  return [sx * px, sy * px * 0.6];
}

async function clusterRow(id) {
  const { rows } = await sql('select x, y, locked, grabbed_by from public.clusters where id = $1', [id]);
  return rows[0];
}

async function traysInDb(groupId) {
  const { rows } = await sql(
    `select owner_id, array_agg(("row" * (select cols from public.sessions s join public.groups g on g.session_id = s.id where g.id = $1)) + col order by "row", col) as pieces
       from public.pieces where group_id = $1 and not on_board and owner_id is not null group by owner_id`,
    [groupId],
  );
  return Object.fromEntries(rows.map((r) => [r.owner_id, r.pieces]));
}

const sorted = (list) => [...list].sort((a, b) => a - b);

// ---------- tests ----------

test('D5~D10: a group of four plays one puzzle together to the end', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const session = await createClass(12); // 4 x 3: three pieces each
  const groupId = session.groupIds[0];
  const students = [];
  for (const name of ['민준', '서연', '지호', '유나']) students.push(await joinStudent(browser, testInfo, session.code, name));
  const [A, B, C, D] = students;
  await startInOneGroup(session, students);

  // D5: 12 pieces dealt 3 / 3 / 3 / 3, each screen shows only its own tray.
  const dealt = await traysInDb(groupId);
  for (const s of students) {
    const mine = (await state(s.page)).tray;
    expect(sorted(mine)).toEqual(sorted(dealt[s.userId]));
    await expect(s.page.locator('.pz-tile')).toHaveCount(3);
    await expect(s.page.getByRole('heading', { level: 1 })).toHaveText('1모둠');
  }
  expect(sorted(Object.values(dealt).flat())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // Groupmates with their names and colours (Presence), me marked.
  for (const s of students) {
    for (const other of students) await expect(s.page.locator('.pz-chips .chip', { hasText: other.name })).toBeVisible();
    await expect(s.page.locator('.pz-chips .chip', { hasText: s.name }).locator('em')).toHaveText('나');
  }
  // Someone else's piece cannot be taken (server check through the store).
  const notMine = dealt[B.userId][0];
  expect(await A.page.evaluate((piece) => window.__puzzle.state().tray.includes(piece), notMine)).toBe(false);
  for (const s of students) await showFrame(s);
  await A.page.screenshot({ path: testInfo.outputPath('coop-1-start.png') });

  // A takes a piece (tap): it appears on every screen.
  const first = (await state(A.page)).tray[0];
  await A.page.locator(`.pz-tile[data-piece="${first}"]`).click();
  await expect(A.page.locator('.pz-tile')).toHaveCount(2);
  for (const s of students) await expect.poll(async () => clusterOf(await state(s.page), first)?.id ?? null).not.toBeNull();
  const placed = clusterOf(await state(B.page), first);

  // D6: B and C grab it at the same time: only one gets it, the others see that one's colour.
  const [releaseB, releaseC] = await Promise.all([pressCluster(B, placed), pressCluster(C, placed, [-14, 10])]);
  await expect.poll(async () => (await clusterRow(placed.id)).grabbed_by).not.toBeNull();
  const holderUid = (await clusterRow(placed.id)).grabbed_by;
  const [winner, loser, releaseWinner, releaseLoser] =
    holderUid === B.userId ? [B, C, releaseB, releaseC] : [C, B, releaseC, releaseB];
  expect([B.userId, C.userId]).toContain(holderUid);
  await expect(loser.page.getByRole('status').filter({ hasText: '친구가 잡고 있는 조각이에요.' })).toBeVisible();
  expect(await loser.page.evaluate(() => window.__puzzle.dragging())).toBeNull();
  expect(await winner.page.evaluate(() => window.__puzzle.dragging())).toBe(placed.id);
  const winnerColor = (await state(A.page)).members.find((m) => m.uid === winner.userId).color;
  for (const s of [A, D, loser]) {
    await expect.poll(() => s.page.evaluate(() => window.__puzzle.holders())).toEqual([
      { id: placed.id, color: ['#F0544F', '#22A559', '#3B82F6', '#9B51E0', '#F2A20C', '#E64C9A'][winnerColor], name: winner.name },
    ]);
  }
  await A.page.screenshot({ path: testInfo.outputPath('coop-2-friend-holds.png') });
  await releaseLoser();

  // The winner lets go a bit further: every screen slides it to the same place (D7, rule 3).
  await releaseWinner();
  await expect.poll(async () => (await clusterRow(placed.id)).grabbed_by).toBeNull();
  const moved = await clusterRow(placed.id);
  for (const s of students) {
    await expect.poll(async () => clusterOf(await state(s.page), first)).toMatchObject({ id: placed.id, x: moved.x, y: moved.y, heldBy: null });
    await expect.poll(() => s.page.evaluate(() => window.__puzzle.holders())).toEqual([]);
  }

  // D7: a neighbour dropped close by snaps on, on every screen, and then they move together.
  // First A puts the piece over the middle of the frame (on another piece's place, so it does
  // not lock): its neighbours' places are then on screen everywhere.
  const { layout, ox: fx, oy: fy } = await frameOrigin(A.page);
  const [col, row] = [first % layout.cols, Math.floor(first / layout.cols)];
  const spotCol = col === 1 ? 2 : 1;
  const spot = { x: fx + (spotCol - col) * layout.pw, y: fy + (1 - row) * layout.ph };
  {
    const from = await cellPoint(A.page, moved.x, moved.y, [col, row]);
    const to = await cellPoint(A.page, spot.x, spot.y, [col, row]);
    await A.input.drag([[from.x, from.y], [to.x, to.y]]);
  }
  await expect.poll(async () => Math.abs((await clusterRow(placed.id)).x - spot.x) < 5).toBe(true);
  const neighbours = [
    [col + 1, row],
    [col - 1, row],
    [col, row + 1],
    [col, row - 1],
  ]
    .filter(([cc, rr]) => cc >= 0 && rr >= 0 && cc < layout.cols && rr < layout.rows)
    .map((cell) => indexOf(cell, layout.cols));
  const traysNow = await traysInDb(groupId);
  // D keeps its tray for the disconnect checks below when someone else can give.
  const canGive = (s) => (traysNow[s.userId] ?? []).some((p) => neighbours.includes(p));
  const giver = [A, B, C].find(canGive) ?? D;
  const neighbour = traysNow[giver.userId].find((p) => neighbours.includes(p));
  await dragFromTray(giver, neighbour, spot.x + 12, spot.y - 9);
  for (const s of students) {
    await expect
      .poll(async () => {
        const st = await state(s.page);
        const both = clusterOf(st, first);
        return both && both === clusterOf(st, neighbour) ? both.pieces.length : 0;
      })
      .toBe(2);
  }
  // Same size: the cluster with the smaller id stays put and the other joins it (snap.js rule 4).
  const merged = clusterOf(await state(A.page), first);
  const mergedRow = await clusterRow(merged.id);
  expect(merged).toMatchObject({ x: mergedRow.x, y: mergedRow.y });
  expect(Math.hypot(merged.x - spot.x, merged.y - spot.y)).toBeLessThan(20);
  const mover = students.find((s) => s !== giver && s !== D);
  const releaseMove = await pressCluster(mover, merged, await awayFromFrame(mover.page, merged, 60));
  await releaseMove();
  await expect.poll(async () => (await clusterRow(merged.id)).x).not.toBe(mergedRow.x);
  const afterMove = await clusterRow(merged.id);
  for (const s of students) {
    await expect.poll(async () => {
      const st = await state(s.page);
      const one = clusterOf(st, first);
      return one === clusterOf(st, neighbour) ? { x: one.x, y: one.y, n: one.pieces.length } : null;
    }).toEqual({ x: afterMove.x, y: afterMove.y, n: 2 });
  }
  await B.page.screenshot({ path: testInfo.outputPath('coop-3-merged.png') });

  // D8: held still for 10 s, the piece is let go by itself, and a friend can take it.
  const still = clusterOf(await state(A.page), first);
  const releaseStill = await pressCluster(A, still, [6, 4]);
  await expect.poll(async () => (await clusterRow(still.id)).grabbed_by).toBe(A.userId);
  const grabbedAt = Date.now();
  await expect.poll(() => A.page.evaluate(() => window.__puzzle.dragging()), { timeout: 15000 }).toBeNull();
  const heldFor = Date.now() - grabbedAt;
  expect(heldFor).toBeGreaterThan(9000);
  await expect.poll(async () => (await clusterRow(still.id)).grabbed_by).toBeNull();
  await releaseStill(); // the finger is lifted later: nothing more happens
  const stillNow = clusterOf(await state(B.page), first);
  const releaseTake = await pressCluster(B, stillNow, await awayFromFrame(B.page, stillNow, 20));
  await expect.poll(async () => (await clusterRow(still.id)).grabbed_by).toBe(B.userId);
  await releaseTake();
  await expect.poll(async () => (await clusterRow(still.id)).grabbed_by).toBeNull();
  testInfo.annotations.push({ type: 'hold-still release after (ms)', description: String(heldFor) });

  // D9: the same device comes back (reload): the same tray.
  const trayBefore = sorted((await state(D.page)).tray);
  await D.page.reload();
  await expect(D.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  expect(sorted((await state(D.page)).tray)).toEqual(trayBefore);

  // D8: D holds a piece and the device goes away: once D counts as disconnected, C takes it.
  await showFrame(D);
  const held = clusterOf(await state(D.page), first);
  await pressCluster(D, held, await awayFromFrame(D.page, held, 10));
  await expect.poll(async () => (await clusterRow(held.id)).grabbed_by).toBe(D.userId);
  await D.context.close();
  await sql("update public.members set last_seen = now() - interval '20 seconds' where id = $1", [D.memberId]);
  for (const s of [A, B, C]) {
    await expect(s.page.locator('.pz-chips .chip', { hasText: D.name }).locator('em')).toHaveText('잠시 나감', { timeout: 15000 });
  }
  await expect.poll(() => A.page.evaluate(() => window.__puzzle.holders())).toEqual([]);
  const heldNow = clusterOf(await state(C.page), first);
  const releaseC2 = await pressCluster(C, heldNow, await awayFromFrame(C.page, heldNow, 20));
  await expect.poll(async () => (await clusterRow(held.id)).grabbed_by).toBe(C.userId);
  await releaseC2();
  await expect.poll(async () => (await clusterRow(held.id)).grabbed_by).toBeNull();
  await A.page.screenshot({ path: testInfo.outputPath('coop-4-friend-away.png') });

  // D9: gone for over a minute: D's tray is dealt to A, B and C (as evenly as possible).
  const before = await traysInDb(groupId);
  expect(before[D.userId].length).toBeGreaterThan(0);
  await sql("update public.members set last_seen = now() - interval '2 minutes' where id = $1", [D.memberId]);
  await A.page.evaluate(() => window.__puzzle.redistribute());
  const after = await traysInDb(groupId);
  expect(after[D.userId]).toBeUndefined();
  // D's pieces went to A, B and C: dealt counts differ by at most one.
  const got = [A, B, C].map((s) => (after[s.userId] ?? []).filter((p) => before[D.userId].includes(p)).length);
  expect(got.reduce((x, y) => x + y)).toBe(before[D.userId].length);
  expect(Math.max(...got) - Math.min(...got)).toBeLessThanOrEqual(1);
  for (const s of [A, B, C]) {
    await expect.poll(async () => sorted((await state(s.page)).tray)).toEqual(sorted(after[s.userId] ?? []));
    await expect(s.page.locator('.pz-tile')).toHaveCount((after[s.userId] ?? []).length);
  }
  await expectNoHorizontalOverflow(A.page);

  // D10: everyone puts the rest into the frame; the last piece shows the celebration to all.
  for (const s of [A, B, C]) {
    const { ox, oy } = await frameOrigin(s.page);
    for (const piece of (await state(s.page)).tray) await dragFromTray(s, piece, ox, oy);
  }
  const { ox, oy } = await frameOrigin(A.page);
  for (const loose of (await state(A.page)).clusters.filter((cl) => !cl.locked)) {
    const from = await cellPoint(A.page, loose.x, loose.y, loose.pieces[0]);
    const to = await cellPoint(A.page, ox, oy, loose.pieces[0]);
    await A.input.drag([[from.x, from.y], [to.x, to.y]]);
  }
  for (const s of [A, B, C]) {
    await expect(s.page.getByRole('heading', { level: 1, name: '1모둠 완성!' })).toBeVisible({ timeout: 15000 });
    await expect(s.page.getByText('모든 조각이 맞았어요')).toBeVisible();
    await expect(s.page.locator('.st-stats')).toContainText('12개');
    await expect(s.page.locator('.st-stats')).toContainText(/\d+초|\d+분/);
    await expect(s.page.locator('.st-done .sub')).toContainText('함께 맞췄어요');
    await expect(s.page.locator('.st-done .sub')).toContainText(s.name);
    await expect(s.page.locator('.st-done-img img')).toHaveJSProperty('complete', true);
    await expectNoHorizontalOverflow(s.page);
  }
  // No ranks: nothing about other groups.
  await expect(A.page.locator('main')).not.toContainText('등');
  const { rows } = await sql('select completed_at from public.groups where id = $1', [groupId]);
  expect(rows[0].completed_at).not.toBeNull();
  await A.page.waitForTimeout(1500); // confetti and heading settle
  await A.page.screenshot({ path: testInfo.outputPath('coop-5-complete.png'), fullPage: true });

  // The class ends: the celebration gives way to the ended message.
  await session.client.rpc('end_session', { p_session: session.id });
  await expect(B.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible();

  for (const s of [A, B, C]) {
    expect(s.errors).toEqual([]);
    expect(await s.page.evaluate(() => window.__cspViolations)).toEqual([]);
    await s.context.close();
  }
});

test("the teacher's own picture (private bucket) and the session's help settings reach the puzzle", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough');
  test.setTimeout(90_000);
  const { client } = await teacherSession();
  const { data: image, error: rowError } = await client.from('images').insert({ width: 1800, height: 1200 }).select().single();
  if (rowError) throw rowError;
  try {
    const bytes = readFileSync(new URL('../../public/images/builtin/sea.webp', import.meta.url));
    const { error: uploadError } = await client.storage.from('images').upload(image.path, bytes, { contentType: 'image/webp' });
    if (uploadError) throw uploadError;
    const { data, error } = await client.rpc('create_session', {
      p_piece_count: 12,
      p_group_count: 1,
      p_image_id: image.id,
      p_hint_preview: true,
      p_hint_outline: false,
      p_hint_picture_button: false,
      p_hint_underlay: true,
    });
    if (error) throw error;
    createdSessions.push(data.id);
    const { rows } = await sql('select id from public.groups where session_id = $1', [data.id]);
    const session = { ...data, client, groupIds: rows.map((r) => Number(r.id)) };
    const s = await joinStudent(browser, testInfo, session.code, '나린');
    await startInOneGroup(session, [s]);
    const st = await state(s.page);
    expect(st.hints).toEqual({ preview: true, outline: false, pictureButton: false, underlay: true });
    expect(st.picture).toMatchObject({ width: 1800, height: 1200 });
    expect(st.picture.src).toMatch(/^blob:/);
    await expect(s.page.getByRole('button', { name: '완성 그림 보기' })).toHaveCount(0);
    await s.page.screenshot({ path: testInfo.outputPath('coop-teacher-picture.png') });
    expect(await s.page.evaluate(() => window.__cspViolations)).toEqual([]);
    expect(s.errors).toEqual([]);
    await s.context.close();
  } finally {
    await client.storage.from('images').remove([image.path]);
    await sql('delete from public.sessions where image_id = $1', [image.id]);
    await client.from('images').delete().eq('id', image.id);
  }
});

test('a class closed by the 24-hour cleanup (no broadcast) is noticed by the puzzle screen', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough');
  test.setTimeout(90_000);
  const session = await createClass(12);
  const s = await joinStudent(browser, testInfo, session.code, '태오');
  await startInOneGroup(session, [s]);
  // What private.cleanup_expired() does to an expired class, for this class only: no 'end' broadcast.
  await sql("update public.sessions set status = 'ended', ended_at = now() where id = $1", [session.id]);
  await sql('delete from public.members where session_id = $1', [session.id]);
  // The next heartbeat (5 s) finds no members row and the class is read again.
  await expect(s.page.getByRole('heading', { level: 1, name: '수업이 끝났어요' })).toBeVisible({ timeout: 20000 });
  expect(await s.page.evaluate(() => localStorage.getItem('jigsaw-student'))).toBeNull();
  expect(await s.page.evaluate(() => window.__puzzle)).toBeUndefined();
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('leaving the page while holding a piece lets it go; coming back signals first', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet-1024', 'one size is enough');
  test.setTimeout(90_000);
  const session = await createClass(12);
  const s = await joinStudent(browser, testInfo, session.code, '라온');
  await startInOneGroup(session, [s]);
  const piece = (await state(s.page)).tray[0];
  await s.page.locator(`.pz-tile[data-piece="${piece}"]`).click();
  await expect.poll(async () => clusterOf(await state(s.page), piece)?.heldBy).toBeNull();
  const cl = clusterOf(await state(s.page), piece);
  const release = await pressCluster(s, cl, [30, 20]);
  await expect.poll(async () => (await clusterRow(cl.id)).grabbed_by).toBe(s.userId);
  const setVisibility = (value) =>
    s.page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
  await setVisibility('hidden');
  await expect.poll(() => s.page.evaluate(() => window.__puzzle.dragging())).toBeNull();
  await expect.poll(async () => (await clusterRow(cl.id)).grabbed_by).toBeNull();
  await release();
  // Back after a long time: heartbeat before anything else, so this tray is not dealt away.
  await sql("update public.members set last_seen = now() - interval '2 minutes' where id = $1", [s.memberId]);
  const calls = [];
  s.page.on('request', (r) => r.url().includes('/rest/v1/rpc/') && calls.push(r.url().split('/rpc/')[1]));
  await setVisibility('visible');
  await expect.poll(() => calls.includes('redistribute_stale')).toBe(true);
  expect(calls.indexOf('heartbeat')).toBeGreaterThanOrEqual(0);
  expect(calls.indexOf('heartbeat')).toBeLessThan(calls.indexOf('redistribute_stale'));
  expect((await traysInDb(session.groupIds[0]))[s.userId]).toHaveLength(11);
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('a student added after the start has no tray and plays with the board', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet-1024', 'one size is enough');
  test.setTimeout(90_000);
  const session = await createClass(12);
  const first = await joinStudent(browser, testInfo, session.code, '하은');
  await startInOneGroup(session, [first]);
  const late = await joinStudent(browser, testInfo, session.code, '도윤');
  await expect(late.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  const { error } = await session.client.rpc('assign_member', { p_member: late.memberId, p_group: session.groupIds[0] });
  if (error) throw error;
  await expect(late.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
  await expect(late.page.locator('.pz-tile')).toHaveCount(0);
  await expect(late.page.getByText('상자가 비었어요. 판 위 조각을 함께 맞춰요')).toBeVisible();
  // A piece the first student puts out shows up and the late student can move it.
  const piece = (await state(first.page)).tray[0];
  await first.page.locator(`.pz-tile[data-piece="${piece}"]`).click();
  await expect.poll(async () => clusterOf(await state(late.page), piece)?.id ?? null).not.toBeNull();
  const cl = clusterOf(await state(late.page), piece);
  await (await pressCluster(late, cl, [40, 30]))();
  await expect.poll(async () => (await clusterRow(cl.id)).x).not.toBe(cl.x);
  await late.page.screenshot({ path: testInfo.outputPath('coop-late-joiner.png') });
  for (const s of [first, late]) {
    expect(s.errors).toEqual([]);
    await s.context.close();
  }
});

test('moving a student to another group switches the puzzle and its channel', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one size is enough');
  test.setTimeout(90_000);
  const session = await createClass(12);
  const [s1, s2] = [
    await joinStudent(browser, testInfo, session.code, '가람'),
    await joinStudent(browser, testInfo, session.code, '나래'),
  ];
  await startInOneGroup(session, [s1, s2]);
  const { error } = await session.client.rpc('assign_member', { p_member: s2.memberId, p_group: session.groupIds[1] });
  if (error) throw error;
  await expect(s2.page.getByRole('heading', { level: 1 })).toHaveText('2모둠', { timeout: 15000 });
  await expect(s2.page.locator('main[data-ready="true"]')).toBeVisible();
  // The new group has all 12 pieces for its only student; the old group's tray went to s1.
  await expect(s2.page.locator('.pz-tile')).toHaveCount(12);
  await expect(s1.page.locator('.pz-tile')).toHaveCount(12);
  // s2 hears its new group only: a piece taken in group 1 does not show up there.
  const piece = (await state(s1.page)).tray[0];
  await s1.page.locator(`.pz-tile[data-piece="${piece}"]`).click();
  await expect.poll(async () => (await state(s1.page)).clusters.length).toBe(1);
  await s2.page.waitForTimeout(1000);
  expect((await state(s2.page)).clusters).toEqual([]);
  for (const s of [s1, s2]) {
    expect(s.errors).toEqual([]);
    await s.context.close();
  }
});

test('completion with reduced motion: no confetti or pop animation', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'one size is enough');
  test.setTimeout(90_000);
  const session = await createClass(12);
  const s = await joinStudent(browser, testInfo, session.code, '소율', { reducedMotion: 'reduce' });
  await startInOneGroup(session, [s]);
  await showFrame(s);
  const { ox, oy } = await frameOrigin(s.page);
  for (const piece of (await state(s.page)).tray) await dragFromTray(s, piece, ox, oy);
  await expect(s.page.getByRole('heading', { level: 1, name: '1모둠 완성!' })).toBeVisible({ timeout: 15000 });
  const animations = await s.page.evaluate(() =>
    [...document.querySelectorAll('.st-confetti i, .st-done h1')].map((el) => getComputedStyle(el).animationName),
  );
  expect(new Set(animations)).toEqual(new Set(['none']));
  await expect(s.page.locator('.st-done .sub')).toHaveText('모둠 친구들과 함께 맞췄어요');
  await s.page.screenshot({ path: testInfo.outputPath('coop-complete-reduced.png') });
  expect(s.errors).toEqual([]);
  await s.context.close();
});

test('an outside picture shows its credit, and a finished puzzle stops reading the board', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'one size is enough');
  test.setTimeout(120_000);
  const index = JSON.parse(readFileSync(new URL('../../public/images/builtin/index.json', import.meta.url), 'utf8'));
  const art = index.images.find((image) => image.key === 'starry-night');
  expect(art.category).not.toBe('자체 제작');
  const session = await createClass(12, { key: art.key, aspect: art.width / art.height });
  const s = await joinStudent(browser, testInfo, session.code, '서아');
  await startInOneGroup(session, [s]);
  expect((await state(s.page)).picture.credit).toBe(art.credit);

  // '완성 그림 보기' shows the picture with its source line.
  await s.page.getByRole('button', { name: '완성 그림 보기' }).click();
  const dialog = s.page.getByRole('dialog', { name: '완성 그림' });
  await expect(dialog.locator('.pz-credit')).toHaveText(art.credit);
  await s.page.screenshot({ path: testInfo.outputPath('coop-credit-dialog.png') });
  await dialog.getByRole('button', { name: '닫기' }).click();

  await showFrame(s);
  const { ox, oy } = await frameOrigin(s.page);
  for (const piece of (await state(s.page)).tray) await dragFromTray(s, piece, ox, oy);
  await expect(s.page.getByRole('heading', { level: 1, name: '1모둠 완성!' })).toBeVisible({ timeout: 15000 });
  await expect(s.page.locator('.st-credit')).toHaveText(art.credit);
  await s.page.waitForTimeout(1200);
  await s.page.screenshot({ path: testInfo.outputPath('coop-credit-complete.png'), fullPage: true });

  // After the celebration: no board reads (15 s) or redistribution (20 s); heartbeat goes on.
  const calls = [];
  s.page.on('request', (r) => calls.push(r.url()));
  await s.page.waitForTimeout(22_000);
  expect(calls.filter((u) => u.includes('/rest/v1/groups') && u.includes('clusters'))).toEqual([]);
  expect(calls.filter((u) => u.includes('/rpc/redistribute_stale'))).toEqual([]);
  expect(calls.filter((u) => u.includes('/rpc/heartbeat')).length).toBeGreaterThanOrEqual(3);
  expect(s.errors).toEqual([]);
  expect(await s.page.evaluate(() => window.__cspViolations)).toEqual([]);
  await s.context.close();
});

for (const pieces of [24, 70]) {
  test(`class puzzle stays smooth on a 4x slower CPU (no long tasks), ${pieces} pieces`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch !== true, 'touch gestures only');
    test.setTimeout(120_000);
    const session = await createClass(pieces);
    const [s, friend] = [
      await joinStudent(browser, testInfo, session.code, '예린'),
      await joinStudent(browser, testInfo, session.code, '시우'),
    ];
    await startInOneGroup(session, [s, friend]);
    for (const [st, n] of [
      [s, 6],
      [friend, 4],
    ]) {
      for (const piece of (await state(st.page)).tray.slice(0, n)) await st.page.locator(`.pz-tile[data-piece="${piece}"]`).click();
    }
    await expect.poll(async () => (await state(s.page)).clusters.length).toBe(10);
    await s.page.waitForTimeout(500);

    const cdp = await s.context.newCDPSession(s.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await s.page.evaluate(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
      }).observe({ type: 'longtask' });
    });
    const { ox, oy } = await frameOrigin(s.page);
    await dragFromTray(s, (await state(s.page)).tray[0], ox + 20, oy + 15);
    const box = await boardBox(s.page);
    const centre = [box.x + box.width / 2, box.y + box.height / 2];
    await s.input.pinch(centre, 80, 220, 20);
    // A friend moves pieces meanwhile: broadcasts arrive and pieces slide on this screen.
    for (const cl of (await state(friend.page)).clusters.filter((c) => !c.locked).slice(0, 3)) {
      const release = await pressCluster(friend, cl, [30, 20]);
      await release();
    }
    const top = (await state(s.page)).clusters.filter((c) => !c.locked).at(-1);
    const at = await cellPoint(s.page, top.x, top.y, top.pieces[0]);
    await s.input.drag([[at.x, at.y], [at.x + 50, at.y - 70]], 20);
    await s.page.waitForTimeout(1200);
    const longTasks = await s.page.evaluate(() => window.__longTasks);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    testInfo.annotations.push({ type: 'long tasks (ms, 4x CPU)', description: JSON.stringify(longTasks) });
    console.log(`[${testInfo.project.name}] class ${pieces} pieces: long tasks at 4x CPU:`, longTasks);
    expect(longTasks.filter((ms) => ms > 50)).toEqual([]);
    for (const st of [s, friend]) {
      expect(st.errors).toEqual([]);
      await st.context.close();
    }
  });
}
