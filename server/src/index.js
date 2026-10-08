// rt.gyosil.app: the jigsaw real-time and judging server (node:http + socket.io).
//   node server/src/index.js     (settings: see config.js; locally `pnpm rt:dev`)
// Start: restore open classes from the database, then listen. Every second the board timers
// run (holds, one-minute rule); every 10 minutes the clean-up job. SIGTERM: stop taking
// requests, finish saving, exit.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createClock } from './clock.js';
import { readConfig } from './config.js';
import { createDbClient } from './db.js';
import { createRegistry } from './engine/registry.js';
import { createBuiltins } from './builtin.js';
import { createHttpHandler } from './http.js';
import { createGoogleVerifier } from './teacher/google.js';
import { createImages, imagePath } from './teacher/images.js';
import { createTeachers } from './teacher/teachers.js';
import { attachSockets } from './sockets.js';
import { startCleanup } from './store/cleanup.js';
import { createPersistence, installShutdown } from './store/persistence.js';
import { restoreOpenSessions } from './store/restore.js';

const TICK_MS = 1000;
const PRUNE_MS = 60_000;

// The screens' deployed copy of the built-in list: the first allowed origin is the screens.
const builtinIndexUrl = (config) => (config.allowedOrigins[0] ? new URL('/images/builtin/index.json', config.allowedOrigins[0]).href : null);

// verifyIdToken: tests pass a fake; otherwise Supabase checks the Google ID token.
export async function startServer({ env = process.env, log = console, proc = process, verifyIdToken } = {}) {
  const config = readConfig(env);
  const now = createClock();
  const db = createDbClient({ url: config.supabaseUrl, serviceRoleKey: config.serviceRoleKey });
  const persistence = createPersistence({ db, log, now });
  const registry = createRegistry({
    now,
    maxOpenSessions: config.limits.maxOpenSessions,
    maxMembers: config.limits.maxMembers,
    maxOpenPerTeacher: config.limits.maxOpenSessionsPerTeacher,
  });
  const restored = await restoreOpenSessions({ registry, persistence, db, now, log });
  if (restored.failed.length > 0) log.error(`[server] 복구하지 못한 수업 ${restored.failed.length}개를 닫았습니다`);

  const teachers = createTeachers(db);
  const images = createImages({
    db,
    isOpenUse: (id) => registry.isImageInUse(id),
    maxPerTeacher: config.limits.maxImagesPerTeacher,
    now,
  });
  const pictureUrl = async (session) => (session.imageId ? images.urlFor(imagePath(session.teacherId, session.imageId)) : null);

  const state = { closing: false };
  const httpServer = createServer();
  let sockets = null;
  const http = createHttpHandler({
    config,
    registry,
    persistence,
    sockets: () => sockets,
    db,
    teachers,
    images,
    builtins: createBuiltins({ indexUrl: builtinIndexUrl(config), log }),
    verifyIdToken: verifyIdToken ?? createGoogleVerifier({ supabaseUrl: config.supabaseUrl, anonKey: config.anonKey }),
    now,
    startedAt: Date.now(),
    state,
    log,
  });
  // socket.io answers /socket.io/ itself and passes every other request here.
  httpServer.on('request', (req, res) => {
    if (req.url?.startsWith('/socket.io/')) return;
    http.handle(req, res);
  });
  sockets = attachSockets({ httpServer, config, registry, persistence, now, pictureUrl, log });

  const tick = setInterval(() => sockets.deliverTagged(registry.tick()), TICK_MS);
  const prune = setInterval(() => http.prune(), PRUNE_MS);
  const stopCleanup = startCleanup(
    { registry, persistence, db, now, onClosed: (closed) => sockets.deliver(closed.session, closed.events) },
    { log },
  );

  // Stops taking requests: no new HTTP or socket work, batches sent, sockets closed.
  async function closeServer() {
    state.closing = true;
    clearInterval(tick);
    clearInterval(prune);
    stopCleanup();
    sockets.broadcaster.flushAll();
    await new Promise((resolve) => sockets.io.close(() => resolve()));
  }
  installShutdown(persistence, { proc, log, beforeFlush: closeServer });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, resolve);
  });
  log.info(`[server] ${config.host}:${config.port} 에서 시작 (복구한 수업 ${restored.restored}개${config.testHooks ? ', 시험 훅 켜짐' : ''})`);
  // close(): for in-process tests; production stops with SIGTERM.
  async function close() {
    await closeServer();
    await persistence.flush();
  }
  return { httpServer, registry, sockets, config, port: httpServer.address().port, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    console.error(`[server] 시작 실패: ${error?.message ?? error}`);
    process.exit(1);
  });
}
