// Dev tool: screenshots of the main screens, for looking at the design after a change.
// Needs `pnpm dev` and `pnpm rt:dev` (local Supabase). Writes PNG files to test-results/screens/
// (not in git): home, teacher sign-in, 새 수업, lobby, overview, student join/waiting/puzzle,
// solo practice — on a phone (390 x 844) and a wide screen (1280 x 800).
// Usage: pnpm screens [picture key]   (default: the first built-in picture)
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { io } from 'socket.io-client';
import { devTeacherToken, ensureLocalTeachers, teacherAuthInitScript } from './lib/local-teacher.mjs';

const SITE = 'http://localhost:4173';
const RT = 'http://127.0.0.1:3400';
const OUT = new URL('../test-results/screens/', import.meta.url).pathname;
const index = JSON.parse(readFileSync(new URL('../public/images/builtin/index.json', import.meta.url), 'utf8'));
const key = process.argv[2] ?? index.images[0].key;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const WIDE = { viewport: { width: 1280, height: 800 } };

mkdirSync(OUT, { recursive: true });
await ensureLocalTeachers();
const token = await devTeacherToken({ rtUrl: RT, origin: SITE });
const browser = await chromium.launch();
const shot = async (page, name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`${OUT}${name}.png`);
};

try {
  for (const [size, options] of [['phone', PHONE], ['wide', WIDE]]) {
    const page = await (await browser.newContext(options)).newPage();
    await page.goto(SITE);
    await shot(page, `${size}-1-home`);
    await page.goto(`${SITE}/teacher`);
    await shot(page, `${size}-2-teacher-sign-in`);
    await page.goto(`${SITE}/play?demo=1&pieces=12&picture=${key}`);
    await shot(page, `${size}-3-practice`);
  }

  // A class: the teacher opens it, two students join, the teacher groups and starts.
  const teacher = await browser.newContext(WIDE);
  await teacher.addInitScript(...teacherAuthInitScript(token));
  const t = await teacher.newPage();
  await t.goto(`${SITE}/teacher/new`);
  await shot(t, 'wide-4-new-class');
  const res = await fetch(`${RT}/api/sessions`, {
    method: 'POST',
    headers: { origin: SITE, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pieceCount: 12, groupCount: 2, picture: { builtinKey: key }, hints: {} }),
  });
  const { sessionId, code } = await res.json();
  const students = [];
  for (const [name, options] of [['가람', PHONE], ['나래', WIDE]]) {
    const page = await (await browser.newContext(options)).newPage();
    await page.goto(`${SITE}/join?code=${code}`);
    if (!students.length) await shot(page, 'phone-5-join-name');
    await page.getByLabel('내 이름').fill(name);
    await page.getByRole('button', { name: '다음' }).click();
    students.push(page);
  }
  await t.goto(`${SITE}/teacher/sessions/${sessionId}`);
  await shot(t, 'wide-6-lobby');
  await t.getByRole('button', { name: '무작위로 나누기' }).click();
  await shot(students[0], 'phone-7-waiting');
  await t.getByRole('button', { name: '시작하기' }).click();
  for (const page of students) await page.locator('main[data-ready="true"]').waitFor({ timeout: 15_000 });
  await shot(students[0], 'phone-8-puzzle');
  await shot(students[1], 'wide-8-puzzle');
  await shot(t, 'wide-9-overview');
  // Close the class again (as 수업 끝내기 does).
  const socket = io(RT, { transports: ['websocket'], extraHeaders: { origin: SITE }, auth: { role: 'teacher', token, sessionId }, reconnection: false });
  await new Promise((resolve) => socket.once('connect', resolve));
  await socket.timeout(5000).emitWithAck('end', {});
  socket.disconnect();
} finally {
  await browser.close();
}
