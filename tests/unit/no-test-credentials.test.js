import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Everything under public/ is deployed (spec D16). The seeded local test teachers
// (supabase/seed.sql) must never appear there: no password, no e-mail, no id. Neither may any
// Supabase key: the browser talks only to the rt server, which alone holds the service_role key.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));
const TEXT_FILE = /\.(?:html|js|mjs|css|json|webmanifest|txt|xml|svg|md)$/i;
const FORBIDDEN = [
  'local-teacher-only',
  'jigsaw.test',
  'teacher1@',
  'teacher2@',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];
// service_role / secret keys (new sb_secret_ and legacy JWT keys), and any Supabase key name.
const KEY_PATTERNS = [/service_role/i, /sb_secret_/, /sb_publishable_/, /eyJ[\w-]{10,}\.[\w-]{10,}\./];
// A real key value (not a name) anywhere in the repository.
const KEY_VALUES = [/sb_secret_[A-Za-z0-9_-]{10,}/, /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/];

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe('deployed files', () => {
  const files = listFiles(PUBLIC_DIR).filter((f) => TEXT_FILE.test(f));

  it('include the teacher screen scripts that are being checked', () => {
    expect(files.some((f) => f.endsWith(join('js', 'config.js')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('teacher', 'login-view.js')))).toBe(true);
  });

  it.each(FORBIDDEN)('never contain the local test teacher credential "%s"', (needle) => {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(needle));
    expect(hits).toEqual([]);
  });

  it.each(KEY_PATTERNS.map((p) => [String(p), p]))('never contain a Supabase key (%s)', (_, pattern) => {
    const hits = files.filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('the repository', () => {
  it('holds no Supabase key value (keys come from `pnpm db:status` locally, /etc/jigsaw-rt.env on the server)', () => {
    const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && (TEXT_FILE.test(f) || /\.(?:sql|toml|sh|ya?ml|env\.example)$/.test(f)));
    expect(tracked.length).toBeGreaterThan(50);
    const hits = tracked.filter((f) => {
      let text;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        return false; // deleted in the working tree
      }
      return KEY_VALUES.some((p) => p.test(text));
    });
    expect(hits).toEqual([]);
  });
});
