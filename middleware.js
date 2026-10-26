// Vercel Routing Middleware: this site's /rt passes requests on to the rt server, for schools that
// block its address but not this site (public/js/rt-client.js rtRoute). Vercel passes no WebSocket,
// so sockets come on long polling at /rt/socket.io (no trailing slash), which is /socket.io/ there.
//
// - Same-origin polling sends no Origin, and the rt server refuses requests without one: they get
//   this site's. A request with another site's Origin keeps it and is refused there.
// - This site's cookies stay here.
// - Caddy sets X-Forwarded-For to Vercel's address, so the client address Vercel saw goes in
//   x-jigsaw-client with RT_PROXY_SECRET in x-jigsaw-proxy; the rt server believes it only with the
//   right secret (server/src/sockets.js proxiedAddress). Without the secret neither is sent.
//
// RT_PROXY_TARGET replaces the rt address for local runs (vercel dev); production leaves it unset.
import { ipAddress, rewrite } from '@vercel/functions';
import { REMOTE_RT_URL } from './public/js/config.js';

export const PROXY_SECRET_HEADER = 'x-jigsaw-proxy';
export const PROXY_CLIENT_HEADER = 'x-jigsaw-client';
const PROXY_PATH = '/rt';

export const config = { matcher: '/rt/:path*', runtime: 'nodejs' };

export default function middleware(request) {
  const rt = (process.env.RT_PROXY_TARGET || REMOTE_RT_URL).replace(/\/+$/, '');
  if (!rt) return new Response(null, { status: 404 });
  const url = new URL(request.url);
  const rest = url.pathname.slice(PROXY_PATH.length);
  const target = `${rt}${rest === '/socket.io' ? '/socket.io/' : rest}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  headers.delete(PROXY_SECRET_HEADER);
  headers.delete(PROXY_CLIENT_HEADER);
  const secret = process.env.RT_PROXY_SECRET;
  const client = ipAddress(request);
  if (secret && client) {
    headers.set(PROXY_SECRET_HEADER, secret);
    headers.set(PROXY_CLIENT_HEADER, client);
  }
  if (!headers.has('origin')) headers.set('origin', url.origin);
  return rewrite(target, { request: { headers } });
}
