// A second local rt server that a test owns (restart.spec.js): started and killed by the test,
// on its own port, so the rt server of the other tests (port 3400, playwright.config.js) keeps
// running. Same settings as scripts/rt-dev.mjs; the process is the server itself (no wrapper),
// so killing it is a real crash. Its output is kept to check that no student name is logged.
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../../server/src/index.js', import.meta.url));

function localStatus() {
  const out = execFileSync('pnpm', ['--silent', 'db:status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const value = (key) => out.match(new RegExp(`^${key}="(.*)"$`, 'm'))?.[1];
  const status = { url: value('API_URL'), serviceKey: value('SERVICE_ROLE_KEY'), anonKey: value('ANON_KEY') };
  if (!status.url || !status.serviceKey) throw new Error('로컬 Supabase 정보를 읽지 못했습니다. `pnpm db:start` 상태를 확인하세요.');
  return status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the rt server on `port` with `secret` (the same secret across a restart keeps teacher
 * tokens valid, like production's fixed SESSION_SECRET). Resolves once /health answers.
 * @returns {Promise<{ url, output: () => string, kill: (signal?) => Promise<void> }>}
 */
export async function startRtServer({ port, secret, env = {} }) {
  const status = localStatus();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      SUPABASE_URL: status.url,
      SUPABASE_SERVICE_ROLE_KEY: status.serviceKey,
      SUPABASE_ANON_KEY: status.anonKey,
      SESSION_SECRET: secret,
      ALLOWED_ORIGINS: 'http://localhost:4173,http://127.0.0.1:4173',
      RT_TEST_HOOKS: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`rt server stopped while starting:\n${output}`);
    const ok = await fetch(`${url}/health`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`rt server did not answer /health:\n${output}`);
    }
    await sleep(100);
  }
  return {
    url,
    output: () => output,
    async kill(signal = 'SIGKILL') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      await exited;
    },
  };
}
