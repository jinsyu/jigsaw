import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Everything under public/ is deployed. The seeded local test teachers
// (supabase/seed.sql) must never appear there: no password, no e-mail.
const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));
const TEXT_FILE = /\.(?:html|js|mjs|css|json|webmanifest|txt|xml|svg|md)$/i;
const FORBIDDEN = ['local-teacher-only', 'jigsaw.test', 'teacher1@', 'teacher2@'];

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
});
