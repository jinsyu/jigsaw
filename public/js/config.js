// Picks the servers from the page address. Only public values live here.
//
// - localhost, 127.0.0.1, private LAN addresses and *.local: the local stack. The rt server
//   (pnpm rt:dev, port 3400) and Supabase (pnpm db:start) on the same host, so a tablet on
//   the same Wi-Fi reaches them through the address it opened the page with.
// - Any other host: the hosted servers. The rt address and the Google client ID are filled
//   in at T25, once rt.gyosil.app runs; until then the teacher and student screens show "준비 중".
//
// Teacher and student screens talk only to the rt server. supabaseUrl / publishableKey are
// read by nothing any more (supabase-client.js goes with the old structure in T23).

const LOCAL_SUPABASE_PORT = 56321;
const LOCAL_RT_PORT = 3400;
// Default publishable key of every local Supabase CLI stack (not a secret).
const LOCAL_PUBLISHABLE_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const REMOTE = {
  env: 'remote',
  supabaseUrl: '',
  publishableKey: '',
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
    supabaseUrl: `http://${apiHost}:${LOCAL_SUPABASE_PORT}`,
    publishableKey: LOCAL_PUBLISHABLE_KEY,
    rtUrl: `http://${apiHost}:${LOCAL_RT_PORT}`,
    // Google sign-in is not set up locally. Open the teacher screens with the seeded test
    // teacher from outside the site: `pnpm teacher:open` (scripts/teacher-open.mjs).
    googleClientId: '',
  };
}

// Old structure (Supabase from the browser), removed in T23.
export function isConfigured(config) {
  return Boolean(config.supabaseUrl && config.publishableKey);
}

// Teacher and student screens (rt server).
export function hasRtServer(config) {
  return Boolean(config.rtUrl);
}
