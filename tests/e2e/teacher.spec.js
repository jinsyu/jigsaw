import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { OTHER_TEACHER_ID } from '../../scripts/lib/local-teacher.mjs';
import { EXACT_3_2, FIRST, KINDS, gridOf, ofKind, picture } from './support/pictures.js';
import { storageAdmin } from './support/storage.js';
import {
  RT_URL,
  classControl,
  cleanUpClasses,
  closeSql,
  deleteImages,
  nodeStudent,
  openClass,
  signInPage,
  sql,
  storeImage,
  teacherToken,
  trackClass,
} from './support/teacher.js';
import { HOSTED_CLIENT_ID, HOSTED_RT, SITE, asHostedSite, fakeGis, rtAnswer } from './support/production.js';

// Teacher screens against the local rt server and Supabase stack (pnpm db:start; Playwright
// starts pnpm rt:dev). Google sign-in is replaced by the seeded test teacher's dev token
// (plan T21); students are Node socket.io clients (browser students: join and coop specs).
// Every test removes what it creates.

const require = createRequire(import.meta.url);
const JSQR_PATH = require.resolve('jsqr');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const createdImages = [];

test.afterAll(async () => {
  await cleanUpClasses();
  await deleteImages(createdImages.splice(0), storageAdmin().storage);
  await closeSql();
});

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

// Requests the page made to Supabase itself. The teacher screens talk only to the rt server;
// a picture's signed URL (Storage) is the one exception (spec D12).
function watchSupabase(page) {
  const direct = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    const isSupabase = url.port === '56321' || url.hostname.endsWith('.supabase.co') || url.pathname.includes('supabase-js');
    if (isSupabase && !url.pathname.startsWith('/storage/v1/object/sign/')) direct.push(r.url());
  });
  return direct;
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

const sessionIdOf = (page) => new URL(page.url()).pathname.split('/').pop();

// Real touch input (CDP), which Chromium turns into pointer events like a tablet would.
async function touchDrag(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) });
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t) });
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

// ---------- sign-in ----------

test('sign-in screen: Google only, no test account on the page; a teacher token signs in, sign-out forgets it', async ({
  page,
  context,
}, testInfo) => {
  const errors = trackErrors(page);
  await page.goto('/teacher');
  await expect(page.getByRole('heading', { level: 1, name: '선생님 로그인' })).toBeVisible();
  // Google is not set up on the local stack, and the page offers no other way in.
  await expect(page.locator('.t-google-slot')).toHaveCount(0);
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
  await expect(page.locator('.t-name')).toHaveText('시험용 선생님');
  await expect(page.getByRole('navigation', { name: '선생님 메뉴' }).getByRole('link', { name: '내 수업' })).toHaveAttribute('aria-current', 'page');
  await expectTouchSize(page.getByRole('button', { name: '로그아웃' }));
  // The token is re-added on each load, so check sign-out without reloading.
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '선생님 로그인' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('jigsaw-teacher'))).toBeNull();
  expect(errors).toEqual([]);
});

test('an expired or refused teacher token goes back to sign-in', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one screen is enough');
  const token = await teacherToken();
  const [body, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const withExpiry = (exp) => `${Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url')}.${signature}`;
  async function openWith(value, path) {
    const context = await browser.newContext({ ...testInfo.project.use });
    // Only when nothing is stored yet, so sign-out can be seen after a reload.
    await context.addInitScript((v) => localStorage.getItem('jigsaw-teacher') || localStorage.setItem('jigsaw-teacher', v), JSON.stringify({ token: value, displayName: '시험용' }));
    const page = await context.newPage();
    const errors = trackErrors(page);
    await page.goto(path);
    return { context, page, errors };
  }

  // Expired (the screen reads the expiry; the signature is the server's job): sign-in at once.
  const expired = await openWith(withExpiry(Date.now() - 1000), '/teacher');
  await expect(expired.page.getByRole('heading', { level: 1, name: '선생님 로그인' })).toBeVisible();
  expect(await expired.page.evaluate(() => localStorage.getItem('jigsaw-teacher'))).toBeNull();
  expect(expired.errors).toEqual([]);
  await expired.context.close();

  // Not accepted by the server (changed after signing): the first request signs the teacher out.
  const forged = await openWith(withExpiry(Date.now() + 3600_000), '/teacher/images');
  await expect(forged.page.getByRole('heading', { level: 1, name: '선생님 로그인' })).toBeVisible();
  await expect(forged.page.getByRole('alert')).toHaveText('다시 로그인해 주세요.');
  expect(await forged.page.evaluate(() => localStorage.getItem('jigsaw-teacher'))).toBeNull();
  expect(forged.errors).toEqual([]);
  await forged.context.close();
});

test('Google sign-in of a new teacher: 함께 퍼즐 시작하기 with the gyosil name filled in, then 내 수업', async ({ browser, baseURL }, testInfo) => {
  test.skip(!['desktop-1440', 'phone-360'].includes(testInfo.project.name), 'one wide and one phone screen');
  // The local stack has no Google client ID (the hosted one: last test of this file). Here the
  // page gets a client ID, a stand-in for the GIS script (served at the real GIS address, which
  // the CSP allows since T23) and stand-in sign-in answers.
  const context = await browser.newContext({ ...testInfo.project.use });
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await context.newPage();
  const errors = trackErrors(page);
  const token = await teacherToken();
  await page.route('**/js/config.js', async (route) => {
    const response = await route.fetch();
    const text = (await response.text()).replace("googleClientId: '',\n  };", "googleClientId: 'test-client.apps.googleusercontent.com',\n  };");
    await route.fulfill({ response, body: text });
  });
  await page.route('https://accounts.google.com/gsi/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.google = { accounts: { id: {
        initialize(o) { window.__gis = o; },
        renderButton(el) { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Google 계정으로 계속'; b.onclick = () => window.__gis.callback({ credential: 'google-id-token' }); el.append(b); },
        disableAutoSelect() {},
      } } };`,
    }),
  );
  const sent = {};
  await page.route(`${RT_URL}/api/teacher/login`, async (route) => {
    sent.login = route.request().postDataJSON();
    await route.fulfill({
      headers: { 'access-control-allow-origin': baseURL },
      json: { ok: true, needsStart: true, startTicket: 'ticket-1', profile: { displayName: '김교실' } },
    });
  });
  await page.route(`${RT_URL}/api/teacher/start`, async (route) => {
    sent.start = route.request().postDataJSON();
    await route.fulfill({ headers: { 'access-control-allow-origin': baseURL }, json: { ok: true, token, teacher: { uid: 'u', displayName: sent.start.displayName } } });
  });

  await page.goto('/teacher');
  await page.getByRole('button', { name: 'Google 계정으로 계속' }).click();
  // The nonce: Google got the SHA-256 of what the rt server got.
  const gisNonce = await page.evaluate(() => window.__gis.nonce);
  expect(sent.login.idToken).toBe('google-id-token');
  expect(sent.login.nonce).toMatch(/^[0-9a-f]{64}$/);
  const { createHash } = await import('node:crypto');
  expect(gisNonce).toBe(createHash('sha256').update(sent.login.nonce).digest('hex'));

  await expect(page.getByRole('heading', { level: 1, name: '함께 퍼즐 시작하기' })).toBeVisible();
  const name = page.getByLabel('선생님 이름');
  await expect(name).toHaveValue('김교실');
  await expect(page.locator('#t-start-name-note')).toHaveText('다른 교실 앱에서 쓰는 이름을 넣어 두었어요. 바꿔도 돼요.');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-start.png'), fullPage: true });
  await page.getByRole('button', { name: '시작하기' }).click();
  await expect(page.getByRole('alert')).toHaveText('개인정보 처리방침에 동의해 주세요.');
  expect(sent.start).toBeUndefined();
  await name.fill('  김교실쌤 ');
  await page.getByLabel(/개인정보 처리방침을 읽었고 동의해요/).check();
  await expectTouchSize(page.locator('.t-agree'));
  await page.getByRole('button', { name: '시작하기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '내 수업' })).toBeVisible();
  expect(sent.start).toEqual({ startTicket: 'ticket-1', displayName: '김교실쌤', agreed: true });
  await expect(page.locator('.t-name')).toHaveText('김교실쌤 선생님');
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('jigsaw-teacher')))).toEqual({ token, displayName: '김교실쌤' });
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

// ---------- 새 수업 ----------

test('D1: a teacher picks a picture, piece count and groups, opens the class, and sees the code and QR', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const errors = trackErrors(page);
  const direct = watchSupabase(page);
  await signInPage(context);
  await page.goto('/teacher/new');
  await expect(page.getByRole('heading', { level: 1, name: '새 수업 만들기' })).toBeVisible();

  // Picture: the first built-in is chosen and previewed with the real 24-piece cut.
  const pictures = page.getByRole('radiogroup', { name: '내장 그림' }).getByRole('radio');
  await expect(pictures).toHaveCount(ofKind(KINDS[0]).length); // the first kind is shown
  await expect(pictures.first()).toBeChecked();
  const preview = page.locator('.t-preview svg');
  const first = gridOf(FIRST, 24);
  await expect(preview).toHaveAttribute('aria-label', new RegExp(`${FIRST.title.replace(/[()]/g, '\\$&')}을 24조각\\(가로 ${first.cols}, 세로 ${first.rows}\\)`));
  // A 3:2 picture, found with the search field.
  const castle = picture(EXACT_3_2);
  await page.getByRole('searchbox', { name: '내장 그림 찾기' }).fill(castle.title);
  await page.getByText(castle.title, { exact: true }).click();
  await expect(page.locator('.t-preview-title')).toHaveText(castle.title);

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
  await expect(page).toHaveURL(new RegExp(`/teacher/sessions/${UUID.source}$`));
  const id = sessionIdOf(page);
  await trackClass(id);

  const code = page.locator('.t-join-code');
  await expect(code).toHaveText(/^수업 코드 \d{3} \d{3}$/);
  const digits = await code.getAttribute('data-code');
  expect(digits).toMatch(/^\d{6}$/);
  await expect(page.locator('.t-join-url')).toHaveText(new URL(baseURL).host);
  await expect(page.getByRole('img', { name: /입장 QR 코드/ })).toBeVisible();
  expect(await readQr(page)).toBe(`${baseURL}/join?code=${digits}`);
  await expect(page.locator('.t-summary')).toHaveText(`${castle.title} · 48조각 · 4모둠`);
  await expect(page.locator('.t-join-hints')).toHaveText('도움: 조각 윤곽선 · 완성 그림 버튼');
  await expect(page.locator('.t-group')).toHaveCount(4);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby.png'), fullPage: true });

  const { rows } = await sql(
    `select s.code, s.status, s.builtin_key, s.piece_count, s.cols, s.rows, s.aspect::float8 as aspect,
            (select count(*)::int from jigsaw.groups g where g.session_id = s.id) as groups
     from jigsaw.sessions s where s.id = $1`,
    [id],
  );
  expect(rows[0]).toMatchObject({ code: digits, status: 'waiting', builtin_key: EXACT_3_2, piece_count: 48, cols: 8, rows: 6, aspect: 1.5, groups: 4 });

  // 내 수업 lists it; the card opens the lobby again.
  await page.getByRole('link', { name: '내 수업', exact: true }).click();
  const card = page.locator(`a.t-session[data-code="${digits}"]`);
  await expect(card).toContainText(castle.title);
  await expect(card).toContainText('48조각 · 4모둠');
  await expect(card).toContainText('학생 기다리는 중');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-home.png'), fullPage: true });
  await card.click();
  await expect(page.locator('.t-join-code')).toHaveAttribute('data-code', digits);

  // 수업 닫기 asks first, then ends the class.
  await page.getByRole('button', { name: '수업 닫기' }).click();
  const dialog = page.getByRole('dialog', { name: '수업을 닫을까요?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '수업 닫기' }).click();
  await dialog.getByRole('button', { name: '수업 닫기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '내 수업' })).toBeVisible();
  await expect.poll(async () => (await sql('select status from jigsaw.sessions where id = $1', [id])).rows[0].status).toBe('ended');
  await expect(page.locator(`.t-past li`, { hasText: castle.title }).first()).toBeVisible();
  await page.goto(`/teacher/sessions/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: '이미 끝난 수업이에요' })).toBeVisible();
  expect(direct).toEqual([]);
  expect(errors).toEqual([]);
});

test('help settings: four switches with defaults, the frame preview follows them, and the class keeps the choice', async ({
  page,
  context,
}, testInfo) => {
  const errors = trackErrors(page);
  await signInPage(context);
  await page.goto('/teacher/new');
  await expect(page.locator('.t-preview svg')).toBeVisible();

  const settings = page.getByRole('group', { name: '도움 설정' });
  const switches = settings.getByRole('switch');
  await expect(switches).toHaveCount(4);
  const preview = settings.getByRole('switch', { name: '들어갈 칸 미리 보기' });
  const outline = settings.getByRole('switch', { name: '틀 안 조각 윤곽선' });
  const pictureButton = settings.getByRole('switch', { name: '완성 그림 보기 버튼' });
  const underlay = settings.getByRole('switch', { name: '틀 안 흐린 밑그림' });
  // Spec defaults, each with a one-line explanation that says the default.
  await expect(preview).not.toBeChecked();
  await expect(outline).toBeChecked();
  await expect(pictureButton).toBeChecked();
  await expect(underlay).not.toBeChecked();
  await expect(preview).toHaveAccessibleDescription(/초록색.*\(기본: 꺼짐\)/);
  await expect(outline).toHaveAccessibleDescription(/\(기본: 켜짐\)/);
  await expect(pictureButton).toHaveAccessibleDescription(/\(기본: 켜짐\)/);
  await expect(underlay).toHaveAccessibleDescription(/\(기본: 꺼짐\)/);

  // The small frame shows what students see: outlines on, no underlay.
  const frame = page.locator('.t-frame-mini svg');
  await expect(frame).toHaveAttribute('aria-label', '학생 판의 틀: 조각 윤곽선 있음, 밑그림 없음');
  await expect(frame.locator('.t-frame-seams')).toHaveCount(1);
  await expect(frame.locator('image')).toHaveCount(0);

  // Keyboard (Space) and pointer (tap on the row) both flip a switch.
  await outline.focus();
  await page.keyboard.press('Space');
  await expect(outline).not.toBeChecked();
  await page.getByText('틀 안 흐린 밑그림').click();
  await expect(underlay).toBeChecked();
  await preview.click();
  await expect(preview).toBeChecked();
  await pictureButton.click();
  await expect(pictureButton).not.toBeChecked();
  await expect(frame).toHaveAttribute('aria-label', '학생 판의 틀: 바깥 테두리만, 흐린 밑그림 있음');
  await expect(frame.locator('.t-frame-seams')).toHaveCount(0);
  await expect(frame.locator('image')).toHaveCount(1);

  await expectTouchSize(settings.locator('.t-switch'));
  await expectNoHorizontalOverflow(page);
  await settings.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('teacher-create-hints.png'), fullPage: true });

  await page.getByRole('button', { name: '수업 열기' }).click();
  await expect(page).toHaveURL(new RegExp(`/teacher/sessions/${UUID.source}$`));
  const id = sessionIdOf(page);
  await trackClass(id);
  const { rows } = await sql('select hint_preview, hint_outline, hint_picture_button, hint_underlay from jigsaw.sessions where id = $1', [id]);
  expect(rows[0]).toEqual({ hint_preview: true, hint_outline: false, hint_picture_button: false, hint_underlay: true });

  // Summaries: the lobby and 내 수업 say which help is on.
  await expect(page.locator('.t-join-hints')).toHaveText('도움: 칸 미리 보기 · 흐린 밑그림');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-hints.png'), fullPage: true });
  const digits = await page.locator('.t-join-code').getAttribute('data-code');
  await page.getByRole('link', { name: '내 수업', exact: true }).click();
  const card = page.locator(`a.t-session[data-code="${digits}"]`);
  await expect(card.locator('.t-session-hints')).toHaveText('도움: 칸 미리 보기 · 흐린 밑그림');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-home-hints.png'), fullPage: true });
  expect(errors).toEqual([]);
});

// ---------- lobby ----------

test('lobby on a 1920 x 1080 whiteboard: big code and QR, no scrolling', async ({ page, context }, testInfo) => {
  await signInPage(context);
  const cls = await openClass({ groups: 6 });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/teacher/sessions/${cls.id}`);
  await expect(page.locator('.t-join-code')).toHaveAttribute('data-code', cls.code);
  const fontSize = await page.locator('.t-join-code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(110); // mockup: 112px
  const qr = await page.locator('.t-join-qr').boundingBox();
  expect(qr.width).toBeGreaterThanOrEqual(300); // mockup: 300px
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight }));
  expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-1920.png') });
});

test('lobby fits a 1024 x 768 tablet without scrolling', async ({ page, context }) => {
  await signInPage(context);
  const cls = await openClass({ groups: 6 });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`/teacher/sessions/${cls.id}`);
  await expect(page.locator('.t-group')).toHaveCount(6);
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight }));
  expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
});

test('D3·D4: names arrive within a second, the teacher groups students (drag, keyboard, shuffle) and starts', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const touch = Boolean(testInfo.project.use.hasTouch);
  const errors = trackErrors(page);
  const direct = watchSupabase(page);
  await signInPage(context);
  const cls = await openClass({ groups: 4 });
  await page.goto(`/teacher/sessions/${cls.id}`);
  await expect(page.locator('.t-join-wait')).toHaveText('학생들이 들어오기를 기다리고 있어요');
  await expect(page.getByRole('button', { name: '시작하기' })).toBeDisabled();
  await expect(page.locator('#t-start-hint')).toHaveText('학생이 들어오면 시작할 수 있어요.');

  // D3: from the join request to the name in the lobby, within a second.
  const latencies = [];
  const students = {};
  for (const name of ['다솜이', '보람찬', '한결이']) {
    const pressed = Date.now();
    students[name] = await nodeStudent(cls.code, name);
    await expect(page.locator('.t-pool .t-chip', { hasText: name })).toBeVisible({ timeout: 1000 });
    latencies.push(Date.now() - pressed);
  }
  testInfo.annotations.push({ type: 'name latency (ms)', description: latencies.join(', ') });
  // Exactly the name: no stray "null" text from optional parts, in the text or the accessible name.
  await expect(page.locator('.t-pool .t-chip', { hasText: '다솜이' })).toHaveText('다솜이');
  await expect(page.getByRole('button', { name: '다솜이', exact: true })).toHaveCount(1);
  await expect(page.locator('.t-pool h3')).toContainText('3명');
  await expect(page.locator('.t-grouping')).not.toContainText('null');
  await expect(page.locator('.t-join-wait')).toHaveText('들어온 학생 3명');
  await expect(page.locator('#t-start-hint')).toHaveText('학생을 모둠에 넣으면 시작할 수 있어요.');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-pool.png'), fullPage: true });

  // 무작위로 나누기: everyone gets a group, and each student hears of it.
  await page.getByRole('button', { name: '무작위로 나누기' }).click();
  await expect(page.locator('.t-pool .t-empty-line')).toHaveText('모든 학생이 모둠에 들어갔어요.');
  for (const s of Object.values(students)) await expect.poll(() => s.state?.me.group ?? null).not.toBeNull();

  // Drag 다솜이 into 1모둠 (touch on touch projects, mouse otherwise).
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
  await expect.poll(() => students['다솜이'].state?.me.group).toBe(1);

  // Keyboard: pick 보람찬 with Enter, place it with its 여기에 놓기 button.
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
  await expect.poll(() => students['보람찬'].state?.me.group).toBe(target);

  // 한결이 back to the pool by keyboard, so the start asks first.
  await page.locator('.t-chip', { hasText: '한결이' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '한결이를 모둠에서 빼기' }).click();
  await expect(page.locator('.t-pool .t-chip', { hasText: '한결이' })).toBeVisible();
  await expect.poll(() => students['한결이'].state?.me.group).toBeNull();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-grouped.png'), fullPage: true });

  // 시작하기 asks about the student without a group, then every group with students starts.
  await page.getByRole('button', { name: '시작하기' }).click();
  const confirm = page.getByRole('dialog', { name: '이대로 시작할까요?' });
  await expect(confirm).toContainText('아직 모둠이 없는 학생이 1명 있어요.');
  await confirm.getByRole('button', { name: '시작하기' }).click();
  await expect(page.locator('.t-ov-card')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '무작위로 나누기' })).toHaveCount(0);
  for (const name of ['다솜이', '보람찬']) {
    const state = await students[name].ready();
    expect(state.group.board.tray.length).toBe(24); // alone in the group: every piece
  }
  expect((await sql('select status from jigsaw.sessions where id = $1', [cls.id])).rows[0].status).toBe('playing');

  // D14: no student name anywhere in the jigsaw schema.
  for (const table of ['sessions', 'groups', 'members', 'images', 'teachers']) {
    const { rows } = await sql(`select coalesce(string_agg(row_to_json(t)::text, ' '), '') as dump from jigsaw.${table} t`);
    for (const name of Object.keys(students)) expect(rows[0].dump, `jigsaw.${table} has ${name}`).not.toContain(name);
  }
  expect(direct).toEqual([]);
  expect(errors).toEqual([]);
});

test('a student who comes back with a fixed name, then leaves (나감)', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440' && testInfo.project.name !== 'phone-360', 'narrowest and widest');
  await signInPage(context);
  const cls = await openClass({ groups: 2 });
  await page.goto(`/teacher/sessions/${cls.id}`);
  const s = await nodeStudent(cls.code, '민쥰');
  await expect(page.locator('.t-chip', { hasText: '민쥰' })).toBeVisible();
  // The same device connects again with the corrected name (the server renames it).
  s.leave();
  await s.enter('민준');
  await expect(page.locator('.t-chip', { hasText: '민준' })).toHaveText('민준');
  await expect(page.locator('.t-chip', { hasText: '민쥰' })).toHaveCount(0);

  // The student leaves: the lobby keeps the name, greyed, with '나감' (offline within ~15 s).
  s.leave();
  const gone = page.locator('.t-chip', { hasText: '민준' });
  await expect(gone).toHaveText('민준나감', { timeout: 15000 });
  await expect(gone.locator('.t-chip-name')).toHaveText('민준');
  await expect(gone.locator('em')).toHaveText('나감');
  await expect(gone).toHaveClass(/\boff\b/);
  await expect(page.locator('.t-grouping')).not.toContainText('null');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-left.png'), fullPage: true });
});

test('connection lost: "다시 연결하는 중" shows, and the lobby catches up after reconnecting', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440' && testInfo.project.name !== 'phone-390', 'one wide and one phone screen');
  const errors = trackErrors(page);
  await signInPage(context);
  const cls = await openClass({ groups: 2 });
  await page.goto(`/teacher/sessions/${cls.id}`);
  await expect(page.locator('.t-join-code')).toBeVisible();
  await context.setOffline(true);
  const band = page.getByRole('status').filter({ hasText: '서버와 연결이 끊겼어요. 다시 연결하는 중이에요…' });
  await expect(band).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.t-join-wait')).toHaveText('연결이 끊겼어요. 다시 연결하는 중이에요…');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-reconnecting.png') });
  // A student joins while the teacher is away; the full state after reconnecting has them.
  await nodeStudent(cls.code, '늦은이');
  await context.setOffline(false);
  await expect(band).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.t-pool .t-chip', { hasText: '늦은이' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('lobby on a 1920 x 1080 whiteboard with 25 students: names, groups and buttons fit without scrolling', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one whiteboard run is enough');
  test.setTimeout(120_000);
  const cls = await openClass({ groups: 6 });
  const names = ['민준', '서연', '지호', '유나', '하은', '도윤', '서준', '지우', '예준', '수아', '시우', '하린', '주원'];
  const more = ['지아', '은우', '채원', '건우', '윤서', '현우', '다은', '선우', '예린', '소율', '연우', '정우'];
  for (const name of [...names, ...more]) await nodeStudent(cls.code, name);
  await signInPage(context);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/teacher/sessions/${cls.id}`);
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
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight }));
  expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
  const columns = await page.locator('.t-groups').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(3); // 6 groups as 3 x 2, like the mockup
  await page.screenshot({ path: testInfo.outputPath('teacher-lobby-1920-25.png') });
});

test('a class started elsewhere turns this lobby into the overview; one ended elsewhere says so', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet-1024', 'one size is enough');
  await signInPage(context);
  const cls = await openClass({ groups: 2 });
  const s = await nodeStudent(cls.code, '가온');
  const control = await classControl(cls);
  await page.goto(`/teacher/sessions/${cls.id}`);
  await expect(page.locator('.t-chip', { hasText: '가온' })).toBeVisible();
  await control.assign(s.memberId, 1);
  await expect(page.locator('.t-group').nth(0).locator('.t-chip', { hasText: '가온' })).toBeVisible();
  await control.start();
  await expect(page.locator('.t-ov-card')).toHaveCount(2);
  await control.end();
  await expect(page.getByRole('heading', { level: 1, name: '이미 끝난 수업이에요' })).toBeVisible();
  control.close();
});

// ---------- states ----------

test('empty, loading-failure and offline states use plain Korean guidance', async ({ page, context }, testInfo) => {
  await signInPage(context);
  await page.route(`${RT_URL}/api/sessions`, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { ok: true, sessions: [] } }) : route.fallback(),
  );
  await page.goto('/teacher');
  await expect(page.getByRole('heading', { name: '아직 만든 수업이 없어요' })).toBeVisible();
  await expect(page.getByRole('link', { name: '첫 수업 만들기' })).toHaveAttribute('href', '/teacher/new');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-home-empty.png'), fullPage: true });

  await page.unroute(`${RT_URL}/api/sessions`);
  await page.route(`${RT_URL}/api/sessions`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, json: { ok: false, error: 'server_error' } })
      : route.fallback(),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('수업 목록을 불러오지 못했어요');
  await page.unroute(`${RT_URL}/api/sessions`);
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.route(`${RT_URL}/api/sessions`, (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.fallback()));
  await page.goto('/teacher/new');
  await expect(page.getByRole('radio', { name: FIRST.title })).toBeChecked();
  const open = page.getByRole('button', { name: '수업 열기' });
  await open.click();
  await expect(page.locator('.t-side .t-error')).toHaveText('인터넷 연결을 확인하고 다시 눌러 주세요.');
  await expect(open).toBeEnabled();
  await expect(page).toHaveURL(/\/teacher\/new$/);

  await page.goto(`/teacher/sessions/${randomUUID()}`);
  await expect(page.getByRole('heading', { level: 1, name: '이 수업을 찾을 수 없어요' })).toBeVisible();
  await page.goto('/teacher/sessions/42');
  await expect(page.getByRole('heading', { level: 1, name: '페이지를 찾을 수 없어요' })).toBeVisible();
  await page.goto('/teacher/nowhere');
  await expect(page.getByRole('heading', { level: 1, name: '페이지를 찾을 수 없어요' })).toBeVisible();
});

test("another teacher's class is not opened", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one screen is enough');
  const theirs = await openClass({ groups: 2, teacherId: OTHER_TEACHER_ID });
  await signInPage(context);
  await page.goto(`/teacher/sessions/${theirs.id}`);
  await expect(page.getByRole('heading', { level: 1, name: '이 수업을 찾을 수 없어요' })).toBeVisible();
  await expect(page.locator('.t-join-code')).toHaveCount(0);
});

test('a picture from 내 그림 can be chosen for a class', async ({ page, context }) => {
  const direct = watchSupabase(page);
  await signInPage(context);
  const file = readFileSync(new URL(`../../public/images/builtin/${EXACT_3_2}-thumb.webp`, import.meta.url));
  const image = await storeImage(file);
  createdImages.push(image.id);

  await page.goto('/teacher/new');
  await page.getByRole('tab', { name: /내 그림/ }).click();
  const panel = page.getByRole('tabpanel', { name: /내 그림/ });
  await expect(panel.getByText('나만 볼 수 있어요 · 지울 때까지 보관')).toBeVisible();
  await expect(panel.getByText('학생 얼굴이 나온 사진은 학교 방침을 확인한 뒤 올려 주세요.')).toBeVisible();
  const mine = panel.locator(`input[value="image:${image.id}"]`);
  await mine.locator('xpath=..').click();
  await expect(mine).toBeChecked();
  await expect(page.locator('.t-preview-title')).toHaveText('내 그림');
  await expect(page.locator('.t-preview image')).toHaveAttribute('href', /\/storage\/v1\/object\/sign\/jigsaw-images\//);
  await page.getByRole('button', { name: '수업 열기' }).click();
  await expect(page).toHaveURL(new RegExp(`/teacher/sessions/${UUID.source}$`));
  const id = sessionIdOf(page);
  await trackClass(id);
  const { rows } = await sql('select image_id, builtin_key, aspect::float8 as aspect from jigsaw.sessions where id = $1', [id]);
  expect(rows[0]).toMatchObject({ image_id: image.id, builtin_key: null, aspect: 1.5 });
  await expect(page.locator('.t-summary')).toHaveText('내 그림 · 24조각 · 6모둠');
  expect(direct).toEqual([]);
});

test('on the hosted site, the teacher signs in through GIS with the gyosil client ID and the rt server at rt.gyosil.app', async ({ page, baseURL }, testInfo) => {
  test.skip(!['desktop-1440', 'phone-360'].includes(testInfo.project.name), 'one wide and one phone screen');
  // Nothing reaches the hosted rt server or Google: their answers are stand-ins (support/production.js).
  const { unexpected } = await asHostedSite(page, baseURL);
  await fakeGis(page);
  const login = [];
  await page.route(`${HOSTED_RT}/api/teacher/login`, (route) => {
    login.push({ origin: route.request().headers().origin, body: route.request().postDataJSON() });
    return route.fulfill(rtAnswer({ ok: true, needsStart: true, startTicket: 'ticket-1', profile: { displayName: '김교실' } }));
  });
  const errors = trackErrors(page);
  await page.goto(`${SITE}/teacher/new`);
  await expect(page.getByRole('heading', { level: 1, name: '선생님 로그인' })).toBeVisible();
  await expect(page.locator('.t-dev-note')).toHaveCount(0);
  await page.getByRole('button', { name: 'Google 계정으로 계속' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '함께 퍼즐 시작하기' })).toBeVisible();
  expect(await page.evaluate(() => window.__gis.client_id)).toBe(HOSTED_CLIENT_ID);
  expect(login).toHaveLength(1);
  expect(login[0].origin).toBe(SITE);
  expect(login[0].body.idToken).toBe('google-id-token');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-hosted-start.png'), fullPage: true });
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
