// Starts the rt server against the local Supabase stack (pnpm db:start first).
// Local values come from `pnpm db:status` at run time and are never written to a file.
// Test hooks are on (local only). Usage: pnpm rt:dev   (PORT env, default 3400)
// RT_LOG_FILE=<path>: the server's output also goes to that file, started empty (the E2E tests
// read it to check that no student name is logged, spec D14).
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function localStatus() {
  const out = execFileSync('pnpm', ['--silent', 'db:status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return Object.fromEntries(
    out
      .split('\n')
      .map((line) => line.match(/^([A-Z0-9_]+)="(.*)"$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
}

const status = localStatus();
if (!status.API_URL || !status.SERVICE_ROLE_KEY) {
  console.error('로컬 Supabase 정보를 읽지 못했습니다. `pnpm db:start` 로 켠 뒤 다시 실행하세요.');
  process.exit(1);
}

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: process.env.PORT ?? '3400',
  SUPABASE_URL: status.API_URL,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: status.ANON_KEY,
  // A new secret each run: teacher tokens from an earlier run stop working (local only).
  SESSION_SECRET: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? 'http://localhost:4173,http://127.0.0.1:4173',
  RT_TEST_HOOKS: '1',
};

const server = fileURLToPath(new URL('../server/src/index.js', import.meta.url));
const logFile = process.env.RT_LOG_FILE;
const child = spawn(process.execPath, [server], { env, stdio: logFile ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
if (logFile) {
  const log = createWriteStream(logFile, { flags: 'w' });
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
