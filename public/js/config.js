// Picks the servers from the page address. Only public values live here.
//
// - localhost, 127.0.0.1, private LAN addresses and *.local: the local rt server (pnpm rt:dev,
//   port 3400) on the same host, so a tablet on the same Wi-Fi reaches it through the address
//   it opened the page with.
// - Any other host: the hosted servers, the rt server at jigsaw-rt.gyosil.app and the gyosil Google
//   sign-in. A config without an rt address (hasRtServer false) makes the teacher and student
//   screens show "준비 중" instead; kept as the fallback for taking the hosted screens offline.
//
// Teacher and student screens talk only to the rt server (pictures of teachers come as signed
// URLs from it), never to Supabase itself.

const LOCAL_RT_PORT = 3400;

// A push to main deploys this: emptying it puts the hosted screens back to "준비 중". This site's
// /rt (middleware.js) passes requests on to the same address.
export const REMOTE_RT_URL = 'https://jigsaw-rt.gyosil.app';
// The same rt server on the server's IP address, for school networks that block the rt address by
// name: Caddy's IP site (scripts/rt/caddy/sites/ip.caddy) takes /jigsaw/X to this app's server as /X.
export const RT_IP_URL = 'https://13.124.90.119';
export const RT_IP_PREFIX = '/jigsaw';

const REMOTE = {
  env: 'remote',
  rtUrl: REMOTE_RT_URL,
  // The public OAuth client ID of the gyosil Google sign-in (the rt server checks the same ID).
  googleClientId: '682345745807-r0ood3p29qp5jvfpfh4mfunpajqvaf7j.apps.googleusercontent.com',
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PRIVATE_IPV4 = /^(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+$/;

export function isLocalHost(hostname) {
  return LOOPBACK.has(hostname) || PRIVATE_IPV4.test(hostname) || hostname.endsWith('.local');
}

export function pickConfig(hostname) {
  if (!isLocalHost(hostname)) return { ...REMOTE };
  const apiHost = LOOPBACK.has(hostname) ? '127.0.0.1' : hostname;
  return {
    env: 'local',
    rtUrl: `http://${apiHost}:${LOCAL_RT_PORT}`,
    // Google sign-in is not set up locally. Open the teacher screens with the seeded test
    // teacher from outside the site: `pnpm teacher:open` (scripts/teacher-open.mjs).
    googleClientId: '',
  };
}

// Teacher and student screens (rt server).
export function hasRtServer(config) {
  return Boolean(config.rtUrl);
}
