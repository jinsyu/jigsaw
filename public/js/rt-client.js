// The screens' way to the rt server (jigsaw-rt.gyosil.app, locally pnpm rt:dev): JSON requests over
// fetch and socket.io connections. The address comes from config.js (rtUrl); when it is empty
// the screens show "준비 중" and never get here. When that address does not answer, both go
// through this site's /rt instead (rtRoute below).
//
// socket.io-client is a pinned copy in js/vendor (no CDN, no script from the rt server), loaded
// only by the screens that keep a connection open.

import { isLocalHost } from './config.js';

const SOCKET_IO_MODULE = new URL('./vendor/socket.io-4.8.4.esm.min.js', import.meta.url).href;

// Some school networks block the rt address but not this site. Then the screens go through this
// site's /rt (middleware.js), which Vercel passes on without WebSocket, so the socket stays on
// long polling. The proxied socket path has no trailing slash; middleware.js maps it to /socket.io/.
export const RT_PROXY_PATH = '/rt';
export const PROBE_TIMEOUT_MS = 3000;

let probe = null;

// One look per page load whether the rt address answers (any answer, even an opaque one).
function reachable(rtUrl) {
  if (probe?.rtUrl !== rtUrl) {
    const answered = fetch(`${rtUrl}/health`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(
      () => true,
      () => false,
    );
    probe = { rtUrl, answered };
  }
  return probe.answered;
}

/**
 * How this page reaches the rt server: straight to rtUrl, or through this site's /rt when rtUrl
 * does not answer. A local rt server (and a page outside a browser) is always straight.
 * @param {string} rtUrl
 * @returns {Promise<{ http: string, socketUrl: string, socketPath: string, pollingOnly: boolean }>}
 */
export async function rtRoute(rtUrl) {
  const direct = { http: rtUrl, socketUrl: rtUrl, socketPath: '/socket.io/', pollingOnly: false };
  const origin = globalThis.location?.origin;
  if (!origin || isLocalHost(new URL(rtUrl).hostname) || (await reachable(rtUrl))) return direct;
  return { http: `${origin}${RT_PROXY_PATH}`, socketUrl: origin, socketPath: `${RT_PROXY_PATH}/socket.io`, pollingOnly: true };
}

// A refused or failed request. `code` is the server's error name (invalid_token, image_in_use,
// …), 'network' when the server could not be reached, 'server_error' for anything else.
export class RtError extends Error {
  constructor(code, status = 0, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'RtError';
    this.code = code;
    this.status = status;
  }

  get network() {
    return this.code === 'network';
  }
}

/**
 * @param {string} rtUrl  e.g. http://127.0.0.1:3400
 * @param {string} path   /api/...
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {string} [options.token]        teacher token (Authorization: Bearer)
 * @param {object} [options.json]         JSON body
 * @param {Blob|ArrayBuffer} [options.body]  raw body (with contentType)
 * @param {string} [options.contentType]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<object>} the answer ({ ok: true, ... })
 */
export async function rtRequest(rtUrl, path, { method = 'GET', token, json, body, contentType, fetchImpl = globalThis.fetch } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload = body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(json);
  } else if (contentType) {
    headers['content-type'] = contentType;
  }
  const { http } = await rtRoute(rtUrl);
  let res;
  try {
    res = await fetchImpl(`${http}${path}`, { method, headers, body: payload, mode: 'cors', credentials: 'omit', cache: 'no-store' });
  } catch (cause) {
    throw new RtError('network', 0, cause);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || data?.ok !== true) throw new RtError(typeof data?.error === 'string' ? data.error : 'server_error', res.status);
  return data;
}

let socketIo = null;

function loadSocketIo() {
  socketIo ??= import(SOCKET_IO_MODULE).catch((error) => {
    socketIo = null; // let the next attempt try again
    throw error;
  });
  return socketIo;
}

/**
 * Opens a socket.io connection. socket.io reconnects by itself after a network loss; a
 * connection the server refused (connect_error with socket.active false) is not retried.
 * @param {string} rtUrl
 * @param {object} auth  { role, token, ... } (server/src/sockets.js)
 */
export async function openSocket(rtUrl, auth) {
  const [{ io }, route] = await Promise.all([loadSocketIo(), rtRoute(rtUrl)]);
  return io(route.socketUrl, {
    path: route.socketPath,
    // socket.io drops a trailing slash from `path` and adds one back only with addTrailingSlash on.
    ...(route.pollingOnly ? { transports: ['polling'], addTrailingSlash: false } : {}),
    auth,
    withCredentials: false,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
}
