import { expect, test } from '@playwright/test';

async function expectNoHorizontalOverflow(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test('home shows the student code entry first', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/코드를 넣어요/);
  const code = page.getByLabel('수업 코드 6자리');
  const enter = page.getByRole('button', { name: '들어가기' });
  await expect(code).toBeVisible();
  await expect(enter).toBeVisible();
  await expect(page.getByRole('link', { name: '수업 만들기 →' })).toHaveAttribute('href', '/teacher');
  await expect(page.getByRole('link', { name: '개인정보 처리방침' })).toHaveAttribute('href', '/privacy');

  // Student entry is the main action: wider than the teacher link and at least 44px tall.
  const codeBox = await code.boundingBox();
  const enterBox = await enter.boundingBox();
  const teacherBox = await page.getByRole('link', { name: '수업 만들기 →' }).boundingBox();
  expect(codeBox.width).toBeGreaterThan(teacherBox.width);
  expect(enterBox.height).toBeGreaterThanOrEqual(44);
  expect(teacherBox.height).toBeGreaterThanOrEqual(44);

  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('home.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('code field keeps digits only and submits to /join', async ({ page }) => {
  await page.goto('/');
  const code = page.getByLabel('수업 코드 6자리');
  await code.fill('482-913a7');
  await expect(code).toHaveValue('482913');
  await page.getByRole('button', { name: '들어가기' }).click();
  await expect(page).toHaveURL(/\/join\?code=482913$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('이름을 알려 주세요');
});

test('app screens are served by index.html and kept out of search', async ({ page }) => {
  await page.goto('/teacher/new');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('선생님 로그인');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('privacy page has no horizontal overflow', async ({ page }, testInfo) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('개인정보 처리방침');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('privacy.png'), fullPage: true });
});

test('SEO files, icons and security headers are served', async ({ request }) => {
  for (const path of ['/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/icon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/og.png']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
  }
  const home = await request.get('/');
  expect(home.headers()['x-content-type-options']).toBe('nosniff');
  expect(home.headers()['x-frame-options']).toBe('DENY');
  const html = await home.text();
  for (const needle of ['rel="canonical"', 'property="og:image"', 'property="og:title"', 'name="description"']) {
    expect(html).toContain(needle);
  }
  expect((await request.get('/vercel.json')).status()).toBe(404);
  expect((await request.get('/package.json')).status()).toBe(404);
});
