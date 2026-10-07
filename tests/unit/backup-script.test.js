import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/db/backup.sh with a stand-in pg_dump: files are mode 600, files older than
// BACKUP_KEEP_DAYS go even when the dump fails (privacy policy: backups at most 14 days), but the
// newest file always stays, and the connection string is never printed.
const SCRIPT = fileURLToPath(new URL('../../scripts/db/backup.sh', import.meta.url));
const DB_URL = 'postgresql://postgres:pw-secret-123@db.example:5432/postgres';
const DAY = 24 * 60 * 60;

let root;
let dir;
let bin;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jigsaw-backup-'));
  dir = join(root, 'backups');
  bin = join(root, 'bin');
  for (const d of [dir, bin]) spawnSync('mkdir', ['-p', d]);
  writeFileSync(
    join(bin, 'pg_dump'),
    '#!/usr/bin/env bash\n[[ "${FAKE_FAIL:-}" == 1 ]] && { echo "connection failed" >&2; exit 1; }\nfor a in "$@"; do case "$a" in --file=*) printf dump > "${a#--file=}" ;; esac; done\n',
  );
  chmodSync(join(bin, 'pg_dump'), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function oldFile(name, daysAgo) {
  const path = join(dir, name);
  writeFileSync(path, 'old');
  const t = Date.now() / 1000 - daysAgo * DAY;
  utimesSync(path, t, t);
}

function run(env = {}) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SUPABASE_DB_URL: DB_URL, BACKUP_DIR: dir, ...env },
  });
}

const files = () => readdirSync(dir).sort();

describe('scripts/db/backup.sh', () => {
  it('writes a mode 600 dump and removes files older than 14 days', () => {
    oldFile('jigsaw-20260901T000000Z.dump', 20);
    oldFile('jigsaw-20260920T000000Z.dump', 10);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const left = files();
    expect(left).not.toContain('jigsaw-20260901T000000Z.dump');
    expect(left).toContain('jigsaw-20260920T000000Z.dump');
    const fresh = left.filter((f) => !f.startsWith('jigsaw-202609'));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(/^jigsaw-\d{8}T\d{6}Z\.dump$/);
    expect(statSync(join(dir, fresh[0])).mode & 0o777).toBe(0o600);
  });

  it('still removes old files when the dump fails, keeping the newest one, and exits non-zero', () => {
    oldFile('jigsaw-20260801T000000Z.dump', 40);
    oldFile('jigsaw-20260810T000000Z.dump', 30);
    oldFile('jigsaw-20260815T000000Z.dump', 20);
    const r = run({ FAKE_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(files()).toEqual(['jigsaw-20260815T000000Z.dump']);
  });

  it('never prints the connection string', () => {
    for (const env of [{}, { FAKE_FAIL: '1' }]) {
      const r = run(env);
      expect(r.stdout + r.stderr).not.toContain('pw-secret-123');
    }
  });

  it('refuses to run without SUPABASE_DB_URL', () => {
    const r = run({ SUPABASE_DB_URL: '' });
    expect(r.status).toBe(2);
    expect(existsSync(dir) && files()).toEqual([]);
  });
});
