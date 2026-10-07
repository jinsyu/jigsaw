// Local static server for public/ that applies the same rules as vercel.json.
// Usage: node scripts/serve.mjs   (PORT env, default 4173)
import { createServer } from 'node:http';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRequest, headersFor } from './lib/vercel-routing.mjs';
import { withLocalSupabase } from './lib/local-csp.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const config = JSON.parse(readFileSync(join(ROOT_DIR, 'vercel.json'), 'utf8'));
const port = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

function toDiskPath(sitePath) {
  const full = join(PUBLIC_DIR, sitePath);
  return full.startsWith(PUBLIC_DIR + sep) ? full : null;
}

function isFile(sitePath) {
  const full = toDiskPath(sitePath);
  if (!full) return false;
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
}

function decodePath(rawUrl) {
  try {
    return decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  const pathname = decodePath(req.url);
  if (!pathname || pathname.includes('\0')) {
    res.writeHead(400).end('Bad request');
    return;
  }
  // No caching locally so edited files show up on reload.
  const headers = { ...headersFor(pathname, config), 'Cache-Control': 'no-store' };
  if (headers['Content-Security-Policy']) {
    headers['Content-Security-Policy'] = withLocalSupabase(headers['Content-Security-Policy'], req.headers.host);
  }
  const result = resolveRequest(pathname, config, isFile);

  if (result.type === 'redirect') {
    res.writeHead(308, { ...headers, Location: result.location }).end();
    return;
  }
  if (result.type === 'notFound') {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const type = MIME[extname(result.path)] ?? 'application/octet-stream';
  res.writeHead(200, { ...headers, 'Content-Type': type });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(toDiskPath(result.path)).pipe(res);
});

server.listen(port, () => {
  console.log(`Serving public/ at http://localhost:${port}`);
});
