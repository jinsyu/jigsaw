// The screens' way to the rt server (rt.gyosil.app, locally pnpm rt:dev): JSON requests over
// fetch and socket.io connections. The address comes from config.js (rtUrl); when it is empty
// the screens show "준비 중" and never get here.
//
// socket.io-client is a pinned copy in js/vendor (no CDN, no script from the rt server), loaded
// only by the screens that keep a connection open.

const SOCKET_IO_MODULE = new URL('./vendor/socket.io-4.8.4.esm.min.js', import.meta.url).href;

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
  let res;
  try {
    res = await fetchImpl(`${rtUrl}${path}`, { method, headers, body: payload, mode: 'cors', credentials: 'omit', cache: 'no-store' });
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
  const { io } = await loadSocketIo();
  return io(rtUrl, {
    path: '/socket.io/',
    auth,
    withCredentials: false,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
}
