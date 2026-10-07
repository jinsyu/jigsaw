// Picks the Supabase project from the page address. Only public values live here:
// the publishable key is meant for browsers, and access is enforced by RLS.
//
// - localhost, 127.0.0.1, private LAN addresses and *.local: the local stack
//   (pnpm db:start). A tablet on the same Wi-Fi reaches it through the same host.
// - Any other host: the hosted project, the shared gyosil Supabase project (jigsaw's tables
//   and RPCs are in its own schema, see supabase-names.js).

const LOCAL_PORT = 56321;
// Default publishable key of every local Supabase CLI stack (not a secret).
const LOCAL_PUBLISHABLE_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const REMOTE = {
  env: 'remote',
  supabaseUrl: 'https://ozfzpyumnaaggrlevygz.supabase.co',
  publishableKey: 'sb_publishable_4aqM2RzByxldw4EokVETtA_Xb_ZyuRa',
  googleSignIn: true,
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
    supabaseUrl: `http://${apiHost}:${LOCAL_PORT}`,
    publishableKey: LOCAL_PUBLISHABLE_KEY,
    // Google sign-in is not set up on the local stack. Sign in with the seeded test
    // teacher from outside the site: `pnpm teacher:open` (scripts/teacher-open.mjs).
    googleSignIn: false,
  };
}

export function isConfigured(config) {
  return Boolean(config.supabaseUrl && config.publishableKey);
}
