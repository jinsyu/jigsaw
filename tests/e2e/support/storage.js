// Service-role access to the local Storage for E2E checks (never used by the app).
// URL and key come from `pnpm db:status` at run time and are never stored in the repo.
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

let admin = null;

export function storageAdmin() {
  if (admin) return admin;
  const out = execFileSync('pnpm', ['--silent', 'db:status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const value = (key) => out.match(new RegExp(`^${key}="(.*)"$`, 'm'))?.[1];
  const url = value('API_URL');
  const key = value('SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('로컬 Supabase 정보를 읽지 못했습니다. `pnpm db:start` 상태를 확인하세요.');
  admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return admin;
}

// Width and height written in a WebP file header (VP8, VP8L or VP8X).
export function webpSize(bytes) {
  const b = Buffer.from(bytes);
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  throw new Error(`not a WebP header: ${chunk}`);
}

// Chunk names after the RIFF header (EXIF and XMP would be listed here).
export function webpChunks(bytes) {
  const b = Buffer.from(bytes);
  const names = [];
  for (let at = 12; at + 8 <= b.length; ) {
    const name = b.toString('latin1', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    names.push(name);
    at += 8 + size + (size % 2);
  }
  return names;
}
