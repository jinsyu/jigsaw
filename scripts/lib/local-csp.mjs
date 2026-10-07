// The production CSP allows only hosted servers. Locally the pages talk to the local stack
// (public/js/config.js: 127.0.0.1, or the LAN host a tablet used): Supabase (picture signed
// URLs) for connections and images, and the rt server (pnpm rt:dev) for connections.
// Everything else stays as in vercel.json.
const LOCAL_SUPABASE_PORT = 56321;
const LOCAL_RT_PORT = 3400;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function withLocalServers(csp, hostHeader = 'localhost') {
  const hostname = hostHeader.replace(/:\d+$/, '');
  const apiHost = LOOPBACK.has(hostname) ? '127.0.0.1' : hostname;
  const supabase = `http://${apiHost}:${LOCAL_SUPABASE_PORT} ws://${apiHost}:${LOCAL_SUPABASE_PORT}`;
  const rt = `http://${apiHost}:${LOCAL_RT_PORT} ws://${apiHost}:${LOCAL_RT_PORT}`;
  return csp
    .split('; ')
    .map((part) => {
      if (part.startsWith('connect-src ')) return `${part} ${supabase} ${rt}`;
      if (part.startsWith('img-src ')) return `${part} ${supabase}`;
      return part;
    })
    .join('; ');
}
