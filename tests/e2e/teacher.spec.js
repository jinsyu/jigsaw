import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { closeSql, deleteSessions, signInPage, sql, teacherSession } from './support/teacher.js';

// Teacher screens against the local Supabase stack (pnpm db:start). Google sign-in is
// replaced by the seeded test teacher (plan T7). Every test removes what it creates.

const require = createRequire(import.meta.url);
const JSQR_PATH = require.resolve('jsqr');
const createdSessions = [];

test.afterAll(async () => {
  await deleteSessions(createdSessions.splice(0));
  await closeSql();
});

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

async function expectTouchSize(locator) {
  const count = await locator.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await locator.nth(i).boundingBox();
    expect(box.height, await locator.nth(i).innerText()).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
}

// Draws the QR SVG on a canvas and reads it with jsQR, like a tablet camera would.
async function readQr(page) {
  // Evaluated (not a <script> tag): the page CSP rightly blocks inline scripts.
  await page.evaluate(readFileSync(JSQR_PATH, 'utf8'));
  return page.evaluate(async () => {
    const svg = document.querySelector('.t-join-qr svg');
    const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 480;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, 480, 480);
    return window.jsQR(g.getImageData(0, 0, 480, 480).data, 480, 480)?.data ?? null;
  });
}

async function openSessionByRpc(groupCount = 6) {
  const { client } = await teacherSession();
  const { data, error } = await client.rpc('create_session', {
    p_piece_count: 24,
    p_group_count: groupCount,
    p_builtin_key: 'sea',
    p_aspect: 1800 / 1200,
  });
  if (error) throw error;
  createdSessions.push(data.id);
  return data;
}

test('sign-in screen: Google only, no test account on the page, injected session signs in', async ({
  page,
  context,
}, testInfo) => {
  const errors = trackErrors(page);
  await page.goto('/teacher');
  await expect(page.getByRole('heading', { level: 1, name: '선생님 로그인' })).toBeVisible();
  // Google is not set up on the local stack, and the page offers no other way in.
  await expect(page.getByRole('button', { name: '구글 계정으로 계속하기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /시험용/ })).toHaveCount(0);
  await expect(page.locator('.t-dev-note')).toContainText('pnpm teacher:open');
  const html = await page.content();
  expect(html).not.toContain('local-teacher-only');
  expect(html).not.toContain('jigsaw.test');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-login.png'), fullPage: true });

  await signInPage(context);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '내 수업' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '선생님 메뉴' }).getByRole('link', { name: '내 수업' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectTouchSize(page.getByRole('button', { name: '로그아웃' }));
  // The injected session is re-added on each load, so check sign-out without reloading.
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '선생님 로그인' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('jigsaw-teacher-auth'))).toBeNull();
  expect(errors).toEqual([]);
});

test('D1: a teacher picks a picture, piece count and groups, opens the class, and sees the code and QR', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const errors = trackErrors(page);
  await signInPage(context);
  await page.goto('/teacher/new');
  await expect(page.getByRole('heading', { level: 1, name: '새 수업 만들기' })).toBeVisible();

  // Picture: the first built-in is chosen and previewed with the real 24-piece cut.
  const pictures = page.getByRole('radiogroup', { name: '내장 그림' }).getByRole('radio');
  await expect(pictures).toHaveCount(50); // public/images/builtin/index.json
  await expect(pictures.first()).toBeChecked();
  const preview = page.locator('.t-preview svg');
  await expect(preview).toHaveAttribute('aria-label', /바다 친구들을 24조각\(가로 6, 세로 4\)/);
  await page.getByText('숲속 마을').click();
  await expect(page.locator('.t-preview-title')).toHaveText('숲속 마을');

  // Piece count with the keyboard (arrow keys move inside the radio group).
  await page.getByRole('radio', { name: '24', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '48', exact: true })).toBeChecked();
  await expect(page.locator('.t-lbl small')).toHaveText('48조각 미리보기');
  await expect(preview).toHaveAttribute('aria-label', /48조각\(가로 8, 세로 6\)/);
  await expect(page.locator('#t-piece-note')).toHaveText('모둠이 4명이면 한 사람에게 12조각씩 나눠 줘요.');

  // Group count: buttons and typing, kept inside 1..12.
  const groups = page.getByRole('spinbutton', { name: '모둠 수', exact: true });
  await page.getByRole('button', { name: '모둠 하나 줄이기' }).click();
  await page.getByRole('button', { name: '모둠 하나 줄이기' }).click();
  await expect(groups).toHaveValue('4');
  await groups.fill('30');
  await groups.blur();
  await expect(groups).toHaveValue('12');
  await expect(page.getByRole('button', { name: '모둠 하나 늘리기' })).toBeDisabled();
  await groups.fill('4');
  await groups.blur();

  await expectTouchSize(page.getByRole('tab'));
  await expectTouchSize(page.locator('.t-seg label'));
  await expectTouchSize(page.locator('.t-stepper button'));
  await expectTouchSize(page.getByRole('navigation', { name: '선생님 메뉴' }).getByRole('link'));
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-create.png'), fullPage: true });

  await page.getByRole('button', { name: '수업 열기' }).click();
  await expect(page).toHaveURL(/\/teacher\/sessions\/\d+$/);
  const id = Number(new URL(page.url()).pathname.split('/').pop());
  createdSessions.push(id);

  const code = page.locator('.t-join-code');
  await expect(code).toHaveText(/^수업 코드 \d{3} \d{3}$/);
  const digits = await code.getAttribute('data-code');
  expect(digits).toMatch(/^\d{6}$/);
  await expect(page.locator('.t-join-url')).toHaveText(new URL(baseURL).host);
  await expect(page.getByRole('img', { name: /입장 QR 코드/ })).toBeVisible();
  expect(await readQr(page)).toBe(`${baseURL}/join?code=${digits}`);
  await expect(page.locator('.t-summary')).toHaveText('숲속 마을 · 48조각 · 4모둠');
  await expect(page.locator('.t-group')).toHaveCount(4);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby.png'), fullPage: true });

  const { rows } = await sql(
    `select s.code, s.status, s.builtin_key, s.piece_count, s.cols, s.rows, s.aspect,
            (select count(*)::int from public.groups g where g.session_id = s.id) as groups
     from public.sessions s where s.id = $1`,
    [id],
  );
  expect(rows[0]).toMatchObject({
    code: digits,
    status: 'waiting',
    builtin_key: 'village',
    piece_count: 48,
    cols: 8,
    rows: 6,
    aspect: 1.5,
    groups: 4,
  });

  // 내 수업 lists it; the card opens the lobby again.
  await page.getByRole('link', { name: '내 수업', exact: true }).click();
  const card = page.locator(`a.t-session[data-code="${digits}"]`);
  await expect(card).toContainText('숲속 마을');
  await expect(card).toContainText('48조각 · 4모둠');
  await expect(card).toContainText('학생 기다리는 중');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-home.png'), fullPage: true });
  await card.click();
  await expect(page.locator('.t-join-code')).toHaveAttribute('data-code', digits);

  // 수업 닫기 asks first, then ends the session.
  await page.getByRole('button', { name: '수업 닫기' }).click();
  const dialog = page.getByRole('dialog', { name: '수업을 닫을까요?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '수업 닫기' }).click();
  await dialog.getByRole('button', { name: '수업 닫기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '내 수업' })).toBeVisible();
  expect((await sql('select status from public.sessions where id = $1', [id])).rows[0].status).toBe('ended');
  await page.goto(`/teacher/sessions/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: '이미 끝난 수업이에요' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('lobby on a 1920 x 1080 whiteboard: big code and QR, no scrolling', async ({ page, context }, testInfo) => {
  await signInPage(context);
  const session = await openSessionByRpc(6);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/teacher/sessions/${session.id}`);
  await expect(page.locator('.t-join-code')).toHaveAttribute('data-code', session.code);
  const fontSize = await page.locator('.t-join-code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(110); // mockup: 112px
  const qr = await page.locator('.t-join-qr').boundingBox();
  expect(qr.width).toBeGreaterThanOrEqual(300); // mockup: 300px
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-1920.png') });
});

test('lobby fits a 1024 x 768 tablet without scrolling', async ({ page, context }) => {
  await signInPage(context);
  const session = await openSessionByRpc(6);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`/teacher/sessions/${session.id}`);
  await expect(page.locator('.t-group')).toHaveCount(6);
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
});

test('empty, loading-failure and offline states use plain Korean guidance', async ({ page, context }, testInfo) => {
  await signInPage(context);
  await page.route('**/rest/v1/sessions?*', (route) => route.fulfill({ json: [] }));
  await page.goto('/teacher');
  await expect(page.getByRole('heading', { name: '아직 만든 수업이 없어요' })).toBeVisible();
  await expect(page.getByRole('link', { name: '첫 수업 만들기' })).toHaveAttribute('href', '/teacher/new');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-home-empty.png'), fullPage: true });

  await page.unroute('**/rest/v1/sessions?*');
  await page.route('**/rest/v1/sessions?*', (route) => route.fulfill({ status: 500, json: { message: 'boom' } }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('수업 목록을 불러오지 못했어요');
  await page.unroute('**/rest/v1/sessions?*');
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.route('**/rest/v1/rpc/create_session', (route) => route.abort('internetdisconnected'));
  await page.goto('/teacher/new');
  await expect(page.getByRole('radio', { name: /바다 친구들/ })).toBeChecked();
  const open = page.getByRole('button', { name: '수업 열기' });
  await open.click();
  await expect(page.locator('.t-side .t-error')).toHaveText('인터넷 연결을 확인하고 다시 눌러 주세요.');
  await expect(open).toBeEnabled();
  await expect(page).toHaveURL(/\/teacher\/new$/);

  await page.goto('/teacher/sessions/999999999999');
  await expect(page.getByRole('heading', { level: 1, name: '이 수업을 찾을 수 없어요' })).toBeVisible();
  await page.goto('/teacher/nowhere');
  await expect(page.getByRole('heading', { level: 1, name: '페이지를 찾을 수 없어요' })).toBeVisible();
});

test('a picture from 내 그림 can be chosen for a class', async ({ page, context }) => {
  const { client } = await signInPage(context);
  const imageId = randomUUID();
  const { data: user } = await client.auth.getUser();
  const path = `${user.user.id}/${imageId}.webp`;
  const file = readFileSync(new URL('../../public/images/builtin/garden-thumb.webp', import.meta.url));
  const { error: rowError } = await client.from('images').insert({ id: imageId, width: 720, height: 480 });
  if (rowError) throw rowError;
  const { error: upError } = await client.storage.from('images').upload(path, file, { contentType: 'image/webp' });
  if (upError) throw upError;

  try {
    await page.goto('/teacher/new');
    await page.getByRole('tab', { name: /내 그림/ }).click();
    const panel = page.getByRole('tabpanel', { name: /내 그림/ });
    await expect(panel.getByText('나만 볼 수 있어요 · 지울 때까지 보관')).toBeVisible();
    await expect(panel.getByText('학생 얼굴이 나온 사진은 학교 방침을 확인한 뒤 올려 주세요.')).toBeVisible();
    const mine = panel.locator(`input[value="image:${imageId}"]`);
    await mine.locator('xpath=..').click();
    await expect(mine).toBeChecked();
    await expect(page.locator('.t-preview-title')).toHaveText('내 그림');
    await expect(page.locator('.t-preview image')).toHaveAttribute('href', /\/storage\/v1\/object\/sign\/images\//);
    await page.getByRole('button', { name: '수업 열기' }).click();
    await expect(page).toHaveURL(/\/teacher\/sessions\/\d+$/);
    const id = Number(new URL(page.url()).pathname.split('/').pop());
    createdSessions.push(id);
    const { rows } = await sql('select image_id, builtin_key, aspect from public.sessions where id = $1', [id]);
    expect(rows[0]).toMatchObject({ image_id: imageId, builtin_key: null, aspect: 1.5 });
    await expect(page.locator('.t-summary')).toHaveText('내 그림 · 24조각 · 6모둠');
  } finally {
    await deleteSessions(createdSessions.splice(0));
    await client.storage.from('images').remove([path]);
    await client.from('images').delete().eq('id', imageId);
  }
});

test('on a host without Supabase settings, teacher screens say 준비 중 and load nothing remote', async ({
  page,
  baseURL,
}, testInfo) => {
  const host = 'http://jigsaw-preview.example.test';
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  await page.route(`${host}/**`, async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(host, baseURL) });
    await route.fulfill({ response });
  });
  const errors = trackErrors(page);
  await page.goto(`${host}/teacher/new`);
  await expect(page.getByRole('heading', { level: 1, name: '선생님 화면은 준비 중이에요' })).toBeVisible();
  await expect(page.getByRole('link', { name: '처음 화면으로' })).toHaveAttribute('href', '/');
  expect(requested.filter((u) => u.includes('supabase-js@') || u.includes(':56321'))).toEqual([]);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-not-ready.png'), fullPage: true });
  expect(errors).toEqual([]);
});
