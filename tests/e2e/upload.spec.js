import { expect, test } from '@playwright/test';
import { signInPage, sql, teacherSession } from './support/teacher.js';
import { PHOTO, cleanUpUploads, createdSessions, expectCleanWebp, storedFile, uploadedImage } from './support/upload.js';

// T8 (D2): teachers upload their own pictures (shrunk to ≤ 2000 px, WebP, no EXIF, private
// bucket) and delete them again (file and row), but not while an open class uses them.
// Runs against the local Supabase stack; everything created here is removed afterwards.

test.afterAll(cleanUpUploads);

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('새 수업: a photo is shrunk, stripped and stored as WebP, then chosen right away', async ({ page, context }, testInfo) => {
  test.skip(!['desktop-1440', 'phone-390'].includes(testInfo.project.name), 'one wide and one phone screen');
  const errors = trackErrors(page);
  await signInPage(context);
  await page.goto('/teacher/new');
  await page.getByRole('tab', { name: /사진 올리기/ }).click();
  const panel = page.locator('#t-panel-upload');
  await expect(panel.getByText('학생 얼굴이 나온 사진은 학교 방침을 확인한 뒤 올려 주세요.')).toBeVisible();
  await expect(panel.getByRole('button', { name: '사진 고르기' })).toBeVisible();
  // The camera button is offered on touch screens only.
  await expect(panel.getByRole('button', { name: '카메라로 찍기' })).toHaveCount(testInfo.project.use.hasTouch ? 1 : 0);
  await page.screenshot({ path: testInfo.outputPath('upload-tab.png') });

  await panel.locator('input[type=file]:not([capture])').setInputFiles(PHOTO);
  const image = await uploadedImage(panel.locator('.t-uploader'));
  // Chosen at once: the 내 그림 tab is shown with the new picture checked and previewed.
  await expect(page.getByRole('tab', { name: /내 그림/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#t-panel-mine input[type=radio]:checked')).toHaveCount(1);
  await expect(page.locator('.t-preview-title')).toHaveText('내 그림');
  await expect(page.locator('.t-preview svg')).toHaveAttribute('aria-label', /세로 6/);
  await expect(page.locator(`#t-panel-mine input[value="image:${image.id}"]`)).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('upload-chosen.png') });
  await expectCleanWebp(image);
  expect(errors).toEqual([]);
});

test('내 그림: delete removes the file and the row, but not while an open class uses it', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one screen is enough');
  const errors = trackErrors(page);
  await signInPage(context);
  await page.goto('/teacher/images');
  await expect(page.getByRole('heading', { level: 1, name: '내 그림' })).toBeVisible();
  await page.locator('.t-images-upload input[type=file]:not([capture])').setInputFiles(PHOTO);
  await expect(page.locator('.t-images-upload').getByRole('status')).toContainText('올렸어요');
  const image = await uploadedImage(page.locator('.t-images-upload .t-uploader'));
  await expectCleanWebp(image);

  // An open class uses it: deleting is refused and both file and row stay.
  const { client } = await teacherSession();
  const { data: session, error } = await client.rpc('create_session', { p_piece_count: 12, p_group_count: 1, p_image_id: image.id });
  if (error) throw error;
  createdSessions.add(session.id);
  await page.reload();
  const card = page.locator(`.t-pic-manage[data-image-id="${image.id}"]`);
  await card.getByRole('button', { name: /지우기/ }).click();
  await expect(card.getByText('지울까요? 파일도 함께 지워져요.')).toBeVisible();
  // --danger-ink: 4.5:1 on white.
  await expect(card.getByRole('button', { name: '지우기', exact: true })).toHaveCSS('color', 'rgb(184, 50, 45)');
  await page.screenshot({ path: testInfo.outputPath('images-confirm.png') });
  await card.getByRole('button', { name: '지우기', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('열려 있는 수업에서 쓰고 있어 지울 수 없어요. 수업을 끝낸 뒤 지워 주세요.');
  expect(await storedFile(image.path)).not.toBeNull();
  expect((await sql('select 1 from public.images where id = $1', [image.id])).rowCount).toBe(1);

  // After the class ends it can go: the Storage file and the row are both gone.
  const { error: endError } = await client.rpc('end_session', { p_session: session.id });
  if (endError) throw endError;
  const nextId = await card.evaluate((el) => el.nextElementSibling?.dataset.imageId ?? null);
  await card.getByRole('button', { name: /지우기/ }).click();
  await card.getByRole('button', { name: '지우기', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '지웠어요.' })).toBeVisible();
  // Focus moves on to the next card's 지우기, or the upload button when there is none.
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el?.matches('.t-upload-pick')) return 'upload';
      return el?.matches('.t-pic-delete') ? el.closest('.t-pic-manage').dataset.imageId : null;
    });
  await expect.poll(focused).toBe(nextId ?? 'upload');
  await expect(card).toHaveCount(0);
  expect(await storedFile(image.path)).toBeNull();
  expect((await sql('select 1 from public.images where id = $1', [image.id])).rowCount).toBe(0);
  expect(errors).toEqual([]);
});

test('clear messages when a file cannot be used or the network fails', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-360', 'one screen is enough');
  await signInPage(context);
  await page.goto('/teacher/images');
  const box = page.locator('.t-images-upload');
  const input = box.locator('input[type=file]:not([capture])');
  const alert = box.getByRole('alert');

  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(alert).toHaveText('사진 파일(JPG, PNG, WebP 등)만 올릴 수 있어요.');

  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await input.setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: tinyPng });
  await expect(alert).toHaveText('사진이 너무 작아요. 긴 변이 200px보다 큰 사진을 골라 주세요.');

  await page.route('**/storage/v1/object/**', (route) => route.abort('internetdisconnected'));
  await input.setInputFiles(PHOTO);
  await expect(alert).toHaveText('올리지 못했어요. 인터넷 연결을 확인하고 다시 올려 주세요.');
  await expect(box.getByRole('button', { name: '사진 고르기' })).toBeEnabled(); // ready to try again
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('upload-error.png') });
});
