// The hosted site in a browser test without touching the hosted servers: this checkout is
// served at https://jigsaw.gyosil.app (so config.js picks the hosted rt server and Google
// client ID), and every request to rt.gyosil.app or Google stays inside the test. A test
// answers the requests it expects with page.route (later routes win); anything else is
// refused and recorded in `unexpected`.

export const SITE = 'https://jigsaw.gyosil.app';
export const HOSTED_RT = 'https://rt.gyosil.app';
export const HOSTED_CLIENT_ID = '682345745807-r0ood3p29qp5jvfpfh4mfunpajqvaf7j.apps.googleusercontent.com';

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} baseURL  the local static server
 * @param {{ csp?: string }} [options]  csp: the Content-Security-Policy to serve instead of the local one
 */
export async function asHostedSite(page, baseURL, { csp } = {}) {
  const unexpected = [];
  const refuse = (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort('blockedbyclient');
  };
  await page.route(`${HOSTED_RT}/**`, refuse);
  await page.route('https://accounts.google.com/**', refuse);
  await page.routeWebSocket(/^wss?:\/\/rt\.gyosil\.app\//, (ws) => {
    unexpected.push(`WS ${ws.url()}`);
    ws.close();
  });
  await page.route(`${SITE}/**`, async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(SITE, baseURL) });
    const headers = { ...response.headers() };
    if (csp && headers['content-security-policy']) headers['content-security-policy'] = csp;
    await route.fulfill({ response, headers });
  });
  return { unexpected };
}

// A stand-in for the GIS script at its real address: records initialize() and draws a button
// that signs in with a fake ID token.
export async function fakeGis(page) {
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
}

// A JSON answer of the hosted rt server to this site (CORS as the server answers it).
export function rtAnswer(json, status = 200) {
  return { status, headers: { 'access-control-allow-origin': SITE }, json };
}
