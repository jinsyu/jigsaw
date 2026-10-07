// The production CSP only allows hosted Supabase. Locally the pages talk to the local
// stack (public/js/config.js: 127.0.0.1, or the LAN host a tablet used), so this server
// adds that origin for connections and images. Everything else stays as in vercel.json.
const LOCAL_SUPABASE_PORT = 56321;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function withLocalSupabase(csp, hostHeader = 'localhost') {
  const hostname = hostHeader.replace(/:\d+$/, '');
  const apiHost = LOOPBACK.has(hostname) ? '127.0.0.1' : hostname;
  const origins = `http://${apiHost}:${LOCAL_SUPABASE_PORT} ws://${apiHost}:${LOCAL_SUPABASE_PORT}`;
  return csp
    .split('; ')
    .map((part) => (part.startsWith('connect-src ') || part.startsWith('img-src ') ? `${part} ${origins}` : part))
    .join('; ');
}
