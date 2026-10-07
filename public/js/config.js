// Picks the servers from the page address. Only public values live here.
//
// - localhost, 127.0.0.1, private LAN addresses and *.local: the local rt server (pnpm rt:dev,
//   port 3400) on the same host, so a tablet on the same Wi-Fi reaches it through the address
//   it opened the page with.
// - Any other host: the hosted servers. The rt address and the Google client ID are filled
//   in at T25, once rt.gyosil.app runs; until then the teacher and student screens show "준비 중".
//
// Teacher and student screens talk only to the rt server (pictures of teachers come as signed
// URLs from it), never to Supabase itself.

const LOCAL_RT_PORT = 3400;

const REMOTE = {
  env: 'remote',
  // T25: the rt.gyosil.app address, only after that server is up (a push here is a deploy).
  rtUrl: '',
  // T25: the public OAuth client ID of the gyosil Google sign-in.
  googleClientId: '',
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PRIVATE_IPV4 = /^(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+$/;

function isLocalHost(hostname) {
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
