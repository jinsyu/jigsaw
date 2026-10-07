// Dev tool: opens a browser window already signed in as the seeded local test teacher,
// because Google sign-in is not set up on the local stack.
// Usage: pnpm dev and pnpm rt:dev (in other terminals), then pnpm teacher:open [url]
//   default url: http://localhost:4173/teacher
import { chromium } from '@playwright/test';
import { devTeacherToken, ensureLocalTeachers, teacherAuthInitScript } from './lib/local-teacher.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/teacher';
const { hostname, origin } = new URL(url);
if (!['localhost', '127.0.0.1'].includes(hostname)) {
  console.error('로컬 주소(localhost)에서만 씁니다.');
  process.exit(1);
}

let token;
try {
  await ensureLocalTeachers();
  token = await devTeacherToken({ origin });
} catch (error) {
  console.error(`시험용 선생님 토큰을 받지 못했습니다. \`pnpm db:start\` 와 \`pnpm rt:dev\` 상태를 확인하세요. (${error.message})`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: null });
await context.addInitScript(...teacherAuthInitScript(token));
const page = await context.newPage();
await page.goto(url);
console.log(`시험용 선생님으로 ${url} 을 열었습니다. 창을 닫으면 끝납니다.`);
page.on('close', () => browser.close());
