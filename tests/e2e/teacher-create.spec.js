import { expect, test } from '@playwright/test';
import { FIRST, INDEX, KINDS, cardDetail, ofKind } from './support/pictures.js';
import { normalizeSearch, pictureSearchText } from '../../public/js/teacher/create-view.js';
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
  await expect(page.locator('.t-chip-filter')).toHaveCount(KINDS.length);
}

// Pictures whose title, theme, kind, maker or year has `words` (create-view.js pictureSearchText).
const INDEX_COUNT = (words) => INDEX.images.filter((i) => pictureSearchText(i).includes(normalizeSearch(words))).length;
const visibleCards = (page) => page.locator('#t-builtin-grid .t-pic:visible');

test('built-in pictures by category: chips, card notes and the source line', async ({ page, context }, testInfo) => {
  const errors = trackErrors(page);
  await openCreate(page, context);
  const chips = page.getByRole('group', { name: '내장 그림 분류' }).getByRole('button');
  await expect(chips).toHaveText(KINDS.map((kind) => `${kind}${ofKind(kind).length}`));
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(visibleCards(page)).toHaveCount(ofKind(KINDS[0]).length);
  await expect(visibleCards(page).first().locator('small')).toHaveText(cardDetail(FIRST));
  await expect(page.locator('#t-credit')).toContainText(FIRST.credit);

  // Paintings: artist and year on the cards; choosing one shows its source line with links.
  const paintings = KINDS.indexOf('명화');
  await chips.nth(paintings).click();
  await expect(chips.nth(paintings)).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
  await expect(visibleCards(page)).toHaveCount(ofKind('명화').length);
  const starry = visibleCards(page).filter({ hasText: '별이 빛나는 밤' });
  await expect(starry.locator('small')).toHaveText('빈센트 반 고흐, 1889');
  await starry.click();
  await expect(page.locator('.t-preview-title')).toHaveText('별이 빛나는 밤');
  const credit = page.locator('#t-credit');
  await expect(credit).toContainText('별이 빛나는 밤, 빈센트 반 고흐, 1889 — 뉴욕 현대미술관');
  await expect(credit.getByRole('link', { name: '원본' })).toHaveAttribute('href', /commons\.wikimedia\.org\/wiki\/File:Van_Gogh_-_Starry_Night/);
  await expect(credit.getByRole('link', { name: '라이선스' })).toHaveAttribute('href', 'https://creativecommons.org/publicdomain/mark/1.0/');

  // Keyboard: arrows move between chips (and show that group); the choice stays chosen.
  await chips.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(chips.nth(1)).toBeFocused();
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(visibleCards(page)).toHaveCount(ofKind(KINDS[1]).length);
  await expect(page.locator('.t-preview-title')).toHaveText('별이 빛나는 밤');
  await page.keyboard.press('End');
  await expect(chips.nth(KINDS.length - 1)).toBeFocused();
  await expect(visibleCards(page)).toHaveCount(ofKind(KINDS.at(-1)).length);

  // Search: words find pictures of every kind; the chips let go; clearing goes back.
  const search = page.getByRole('searchbox', { name: '내장 그림 찾기' });
  await search.fill('고흐');
  await expect(visibleCards(page)).toHaveCount(INDEX_COUNT('고흐'));
  for (let i = 0; i < KINDS.length; i++) await expect(chips.nth(i)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status').filter({ hasText: '장 찾았어요' })).toBeVisible();
  await search.fill('없는그림이름');
  await expect(visibleCards(page)).toHaveCount(0);
  await expect(page.getByText('찾는 그림이 없어요.')).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(chips.nth(KINDS.length - 1)).toHaveAttribute('aria-pressed', 'true');

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

test('wide panel: a fade and a small button point to the help settings below', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'sizes are set here');
  await page.setViewportSize({ width: 1024, height: 768 });
  await openCreate(page, context);
  await expect(page.locator('.t-preview svg')).toBeVisible();
  const body = page.locator('.t-side-body');
  const more = page.getByRole('button', { name: '아래에 도움 설정이 있어요' });
  await expect(more).toBeVisible();
  await expect(body).toHaveClass(/has-more/);
  // The help settings are below the first screen of the panel.
  const hints = page.locator('#t-hints legend');
  const out = await hints.evaluate((el) => el.getBoundingClientRect().top > el.closest('.t-side-body').getBoundingClientRect().bottom);
  expect(out).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('create-1024-more.png') });

  // Pressing it brings the help settings into the panel and moves focus to the first switch.
  await more.click();
  await expect(page.locator('#t-hint-preview')).toBeFocused();
  await expect
    .poll(() => hints.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const b = el.closest('.t-side-body').getBoundingClientRect();
      return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    }))
    .toBe(true);
  // At the very end of the list the hint goes away.
  await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(more).toBeHidden();
  await expect(body).not.toHaveClass(/has-more/);
  await page.screenshot({ path: testInfo.outputPath('create-1024-end.png') });
});

test('reduced motion: the help settings button scrolls at once', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'sizes are set here');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1024, height: 768 });
  await openCreate(page, context);
  await expect(page.locator('.t-preview svg')).toBeVisible();
  const body = page.locator('.t-side-body');
  await page.getByRole('button', { name: '아래에 도움 설정이 있어요' }).click();
  // Read right away: no smooth scrolling in between.
  const top = await body.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
});

test('narrow screens: the open bar leaves room for the last switch and the home indicator', async ({ page, context }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('phone'), 'phones only');
  await openCreate(page, context);
  // The padding follows the safe area (the home indicator on iPhones).
  const rule = await page.evaluate(() =>
    [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules];
      } catch {
        return [];
      }
    })
      .flatMap((r) => (r.cssRules ? [...r.cssRules] : [r]))
      .map((r) => r.cssText)
      .find((t) => t.startsWith('.t-create { padding-bottom')),
  );
  expect(rule).toContain('env(safe-area-inset-bottom)');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const last = await page.locator('.t-switch').last().boundingBox();
  const bar = await page.locator('.t-side-foot').boundingBox();
  expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
  await expect(page.getByRole('button', { name: '아래에 도움 설정이 있어요' })).toBeHidden();
});

test('card notes stay whole on narrow screens, and a category shows its pictures at once', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-360' && testInfo.project.name !== 'desktop-1440', 'narrowest and widest');
  await openCreate(page, context);
  const chips = page.getByRole('group', { name: '내장 그림 분류' }).getByRole('button');
  for (const index of KINDS.keys()) {
    await chips.nth(index).click();
    // Thumbnails of the shown category load at once (no blank cards after switching).
    await expect
      .poll(() =>
        page.locator('#t-builtin-grid .t-pic:visible img').evaluateAll((imgs) => imgs.every((img) => img.complete && img.naturalWidth > 0)),
        { timeout: 3000 },
      )
      .toBe(true);
    // Notes (artist, year) are not cut off: up to two lines, all of it shown.
    const cut = await page
      .locator('#t-builtin-grid .t-pic:visible .t-pic-cap small')
      .evaluateAll((els) => els.filter((el) => el.scrollHeight > el.clientHeight + 1).map((el) => el.textContent));
    expect(cut).toEqual([]);
  }
  await page.screenshot({ path: testInfo.outputPath('create-notes.png') });
});

for (const size of [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`${size.width} x ${size.height}: piece and group counts stay clear of the fade and the hint button`, async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'sizes are set here');
    await page.setViewportSize(size);
    await openCreate(page, context);
    await expect(page.locator('.t-preview svg')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const body = document.querySelector('.t-side-body');
      const fade = body.classList.contains('has-more') ? parseFloat(getComputedStyle(body).getPropertyValue('--fade')) : 0;
      const b = body.getBoundingClientRect();
      const more = document.querySelector('.t-side-more');
      const m = more.hidden ? null : more.getBoundingClientRect();
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
      return {
        clearTop: b.top,
        clearBottom: b.bottom - fade,
        more: m && { top: m.top, bottom: m.bottom, left: m.left, right: m.right },
        controls: { pieces: rect('.t-seg'), groups: rect('.t-stepper'), groupInput: rect('#t-group-count') },
      };
    });
    for (const [name, r] of Object.entries(geometry.controls)) {
      expect(r.top, name).toBeGreaterThanOrEqual(geometry.clearTop - 1);
      expect(r.bottom, name).toBeLessThanOrEqual(geometry.clearBottom + 1);
      if (geometry.more) {
        const overlaps = r.left < geometry.more.right && r.right > geometry.more.left && r.top < geometry.more.bottom && r.bottom > geometry.more.top;
        expect(overlaps, `${name} under the hint button`).toBe(false);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`create-${size.width}-clear.png`) });
  });
}

// 다시 열기 on 내 수업 opens 새 수업 with the earlier class's choices in the address.
test('새 수업 starts from the choices in its address (다시 열기)', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440' && testInfo.project.name !== 'phone-390', 'two sizes are enough');
  const errors = trackErrors(page);
  await signInPage(context);
  await page.goto('/teacher/new?picture=great-wave&pieces=48&groups=5&preview=1&outline=0&button=1&underlay=1');
  await expect(page.locator('.t-preview-title')).toHaveText('가나가와 해변의 큰 파도');
  await expect(page.getByRole('radio', { name: /가나가와 해변의 큰 파도/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: '48', exact: true })).toBeChecked();
  await expect(page.getByRole('spinbutton', { name: '모둠 수', exact: true })).toHaveValue('5');
  await expect(page.getByRole('switch', { name: '들어갈 칸 미리 보기' })).toBeChecked();
  await expect(page.getByRole('switch', { name: '틀 안 조각 윤곽선' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: '틀 안 흐린 밑그림' })).toBeChecked();
  // The chip of the picture's kind is the one shown.
  await expect(page.getByRole('group', { name: '내장 그림 분류' }).getByRole('button', { pressed: true })).toHaveText(/^명화/);
  expect(errors).toEqual([]);
});
