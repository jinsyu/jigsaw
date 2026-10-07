// E2E helpers for the student screens in the browser (join, coop, disconnect, csp): every
// student is its own browser context against the local rt server (playwright.config.js). The
// teacher's moves come from Node (support/teacher.js classControl).
import { expect } from '@playwright/test';
import { makeInput } from './puzzle.js';

export const savedKeyOf = (code) => `jigsaw-student:${code}`;
export const savedEntry = (page, code) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), savedKeyOf(code));

// Adds the hosts of everything a page asks for (HTTP and WebSocket) to `hosts`.
function watchHosts(page, hosts) {
  const add = (address) => {
    const url = new URL(address);
    if (url.protocol.startsWith('http') || url.protocol.startsWith('ws')) hosts.add(url.host);
  };
  page.on('request', (request) => add(request.url()));
  page.on('websocket', (ws) => add(ws.url()));
}

/**
 * A browser context for one student, with CSP violations, page errors and hosts recorded.
 * @returns {Promise<{ name, context, page, errors, hosts, sent, input, newPage }>}
 */
export async function studentContext(browser, testInfo, name, { reducedMotion } = {}) {
  const context = await browser.newContext({ ...testInfo.project.use, reducedMotion });
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  // sent: socket.io frames the pages sent (e.g. '42["release",{}]').
  const student = { name, context, page: null, errors: [], hosts: new Set(), sent: [], input: null };
  // A new tab of the same device (same localStorage), e.g. after closing the page.
  student.newPage = async () => {
    const page = await context.newPage();
    page.on('pageerror', (e) => student.errors.push(e.message));
    // Logged (handled) errors are reported with the test, to explain a failure.
    page.on('console', (m) => m.type() === 'error' && testInfo.annotations.push({ type: `console (${name})`, description: m.text() }));
    watchHosts(page, student.hosts);
    page.on('websocket', (ws) => ws.on('framesent', (frame) => student.sent.push(String(frame.payload))));
    student.page = page;
    student.input = makeInput(page, testInfo);
    return page;
  };
  await student.newPage();
  return student;
}

/** Joins class `cls` with the address of its QR code and a name; resolves on the waiting screen. */
export async function joinStudent(browser, testInfo, cls, name, options) {
  const student = await studentContext(browser, testInfo, name, options);
  await student.page.goto(`/join?code=${cls.code}`);
  await student.page.getByLabel('내 이름').fill(name);
  await student.page.getByRole('button', { name: '다음' }).click();
  await expect(student.page.getByRole('heading', { level: 1, name: '선생님이 모둠을 정하고 있어요' })).toBeVisible();
  return student;
}

// Students into group `number` (colours in joining order), then start; resolves when every
// puzzle is on screen.
export async function startInOneGroup(control, students, number = 1) {
  for (const s of students) await control.assign(await control.memberId(s.name), number);
  await control.start();
  for (const s of students) await expect(s.page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15000 });
}

export const cspViolations = (page) => page.evaluate(() => window.__cspViolations);

// Requests to Supabase straight from the page (none since T22: the rt server answers everything).
export const supabaseHosts = (hosts) => [...hosts].filter((h) => h.endsWith(':56321') || h.endsWith('.supabase.co'));
