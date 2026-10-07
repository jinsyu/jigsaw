import { existsSync } from 'node:fs';
import { expect, test, webkit } from '@playwright/test';
import { signInPage } from './support/teacher.js';
import { PHOTO, cleanUpUploads, expectCleanWebp, uploadedImage } from './support/upload.js';

// T8 on WebKit (the Safari engine): canvas.toBlob cannot make WebP there, so the pinned WASM
// encoder is loaded from the CDN. Needs `pnpm exec playwright install webkit`; skipped otherwise.
test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed (pnpm exec playwright install webkit)');
test.use({ browserName: 'webkit' });
test.afterAll(cleanUpUploads);

test('uploads through the WASM encoder under the site CSP', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one project is enough');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdn = [];
  page.on('request', (r) => r.url().includes('@jsquash/webp') && cdn.push(r.url()));
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await signInPage(context);
  await page.goto('/teacher/images');
  const canvasType = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    return (await new Promise((r) => c.toBlob(r, 'image/webp'))).type;
  });
  expect(canvasType).toBe('image/png'); // why the encoder is needed
  await page.locator('.t-images-upload input[type=file]:not([capture])').setInputFiles(PHOTO);
  await expect(page.locator('.t-images-upload').getByRole('status')).toContainText('올렸어요', { timeout: 30_000 });
  expect(cdn.some((u) => u.endsWith('.wasm'))).toBe(true);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  const image = await uploadedImage(page.locator('.t-images-upload .t-uploader'));
  await expectCleanWebp(image);
  expect(errors).toEqual([]);
});
