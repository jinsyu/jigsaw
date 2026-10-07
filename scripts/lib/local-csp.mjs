// The production CSP allows only hosted servers. Locally the pages talk to the local stack
// (public/js/config.js: 127.0.0.1, or the LAN host a tablet used): the rt server (pnpm rt:dev)
// for connections, and the local Supabase Storage for teachers' pictures, through signed URLs
// only (the same path as in production, for connections and images).
// Everything else stays as in vercel.json.
const LOCAL_SUPABASE_PORT = 56321;
const LOCAL_RT_PORT = 3400;
const SIGNED_PICTURES_PATH = '/storage/v1/object/sign/jigsaw-images/';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function withLocalServers(csp, hostHeader = 'localhost') {
  const hostname = hostHeader.replace(/:\d+$/, '');
  const apiHost = LOOPBACK.has(hostname) ? '127.0.0.1' : hostname;
  const pictures = `http://${apiHost}:${LOCAL_SUPABASE_PORT}${SIGNED_PICTURES_PATH}`;
  const rt = `http://${apiHost}:${LOCAL_RT_PORT} ws://${apiHost}:${LOCAL_RT_PORT}`;
  return csp
    .split('; ')
    .map((part) => {
      if (part.startsWith('connect-src ')) return `${part} ${rt} ${pictures}`;
      if (part.startsWith('img-src ')) return `${part} ${pictures}`;
      return part;
    })
    .join('; ');
}
