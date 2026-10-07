import { expect, test } from '@playwright/test';
import { closeSql, signInPage } from './support/teacher.js';

// 새 수업 만들기: built-in pictures by category, card notes, the source line of the chosen
// picture, and '수업 열기' on the first screen at every size. Reads only; creates nothing.

test.afterAll(async () => {
  await closeSql();
});

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function openCreate(page, context) {
  await signInPage(context);
  await page.goto('/teacher/new');
  await expect(page.getByRole('heading', { level: 1, name: '새 수업 만들기' })).toBeVisible();
  await expect(page.locator('.t-chip-filter')).toHaveCount(5);
}

const visibleCards = (page) => page.locator('#t-builtin-grid .t-pic:visible');

test('built-in pictures by category: chips, card notes and the source line', async ({ page, context }, testInfo) => {
  const errors = trackErrors(page);
  await openCreate(page, context);
  const chips = page.getByRole('group', { name: '내장 그림 분류' }).getByRole('button');
  await expect(chips).toHaveText(['자체 제작20', '명화12', '우리 그림9', '사진6', '삽화3']);
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(visibleCards(page)).toHaveCount(20);
  await expect(visibleCards(page).first().locator('small')).toHaveText('자연'); // theme of a self-made scene
  await expect(page.locator('#t-credit')).toHaveText('함께 퍼즐이 직접 그린 그림이에요.');

  // Paintings: artist and year on the cards; choosing one shows its source line with links.
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
  await expect(visibleCards(page)).toHaveCount(12);
  const starry = visibleCards(page).filter({ hasText: '별이 빛나는 밤' });
  await expect(starry.locator('small')).toHaveText('빈센트 반 고흐, 1889');
  await starry.click();
  await expect(page.locator('.t-preview-title')).toHaveText('별이 빛나는 밤');
  const credit = page.locator('#t-credit');
  await expect(credit).toContainText('별이 빛나는 밤, 빈센트 반 고흐, 1889 — 뉴욕 현대미술관');
  await expect(credit.getByRole('link', { name: '원본' })).toHaveAttribute('href', /commons\.wikimedia\.org\/wiki\/File:Van_Gogh_-_Starry_Night/);
  await expect(credit.getByRole('link', { name: '라이선스' })).toHaveAttribute('href', 'https://creativecommons.org/publicdomain/mark/1.0/');

  // Keyboard: arrows move between chips (and show that group); the choice stays chosen.
  await chips.nth(1).focus();
  await page.keyboard.press('ArrowRight');
  await expect(chips.nth(2)).toBeFocused();
  await expect(chips.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(visibleCards(page)).toHaveCount(9);
  await expect(page.locator('.t-preview-title')).toHaveText('별이 빛나는 밤');
  await page.keyboard.press('End');
  await expect(chips.nth(4)).toBeFocused();
  await expect(visibleCards(page)).toHaveCount(3);

  // No sideways scrolling of the page; on phones the chip row scrolls by itself.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('create-categories.png') });
  expect(errors).toEqual([]);
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 360, height: 780 },
]) {
  test(`'수업 열기' is on the first screen at ${size.width} x ${size.height}`, async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'sizes are set here');
    await page.setViewportSize(size);
    await openCreate(page, context);
    await expect(page.locator('.t-preview svg')).toBeVisible();
    const open = page.getByRole('button', { name: '수업 열기' });
    const box = await open.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    // Nothing covers it: the button itself is what a tap on its middle reaches.
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    expect(hit).toBe('수업 열기');
    await page.screenshot({ path: testInfo.outputPath(`create-${size.width}x${size.height}.png`) });
  });
}
