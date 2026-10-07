// Reads the local Supabase URL and keys once per test run.
// Keys come from `pnpm db:status` (npx supabase status -o env) at run time and are
// never written to the repository.
import { execFileSync } from 'node:child_process';

function parseEnvLines(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)="(.*)"$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function readLocalStatus() {
  try {
    const out = execFileSync('pnpm', ['--silent', 'db:status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseEnvLines(out);
  } catch {
    return {};
  }
}

export default async function setup(project) {
  const status = readLocalStatus();
  const env = {
    url: process.env.SUPABASE_URL ?? status.API_URL,
    anonKey: process.env.SUPABASE_ANON_KEY ?? status.ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? status.SERVICE_ROLE_KEY,
    dbUrl: process.env.SUPABASE_DB_URL ?? status.DB_URL,
  };
  if (!env.url || !env.anonKey || !env.serviceKey || !env.dbUrl) {
    throw new Error('로컬 Supabase 정보를 읽지 못했습니다. `pnpm db:start` 로 켠 뒤 다시 실행하세요.');
  }
  const health = await fetch(`${env.url}/auth/v1/health`, { headers: { apikey: env.anonKey } }).catch(
    () => null,
  );
  if (!health?.ok) {
    throw new Error(`로컬 Supabase(${env.url})에 연결하지 못했습니다. \`pnpm db:start\` 상태를 확인하세요.`);
  }
  project.provide('supabase', env);
}
