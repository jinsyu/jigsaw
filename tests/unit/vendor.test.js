import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// public/js/vendor keeps third-party files as they were published; LICENSES.md records
// each one with its SHA-256 so a changed or unlisted file is noticed.
const VENDOR = fileURLToPath(new URL('../../public/js/vendor', import.meta.url));
const licenses = readFileSync(join(VENDOR, 'LICENSES.md'), 'utf8');

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}
const vendored = filesUnder(VENDOR)
  .map((f) => relative(VENDOR, f).split('\\').join('/'))
  .filter((f) => !/^LICENSE/.test(f));
const sha256 = (file) => createHash('sha256').update(readFileSync(join(VENDOR, file))).digest('hex');

describe('public/js/vendor', () => {
  it.each(vendored)('%s is listed in LICENSES.md with its SHA-256', (file) => {
    const name = file.split('/').at(-1);
    expect(licenses).toContain(name);
    expect(licenses).toContain(sha256(file));
  });

  it('keeps the full Apache 2.0 text next to the Apache-licensed code', () => {
    expect(readFileSync(join(VENDOR, 'LICENSE-Apache-2.0.txt'), 'utf8')).toContain('Apache License');
  });
});
