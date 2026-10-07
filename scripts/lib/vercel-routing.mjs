// Mirrors the subset of Vercel static routing that vercel.json uses:
// filesystem first, then cleanUrls, then rewrites; headers by source pattern.

const REGEX_CHARS = /[.+?^${}|[\]\\*]/g;

// Supports "/literal", "/:name", "/:name*" and raw groups such as "/(.*)".
export function sourceToRegExp(source) {
  let re = '';
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    let m;
    if ((m = rest.match(/^\/:\w+\*/))) {
      re += '(?:/.*)?';
      i += m[0].length;
    } else if ((m = rest.match(/^:\w+/))) {
      re += '([^/]+)';
      i += m[0].length;
    } else if (rest[0] === '(') {
      const end = source.indexOf(')', i);
      if (end < 0) throw new Error(`Unclosed group in source: ${source}`);
      re += source.slice(i, end + 1);
      i = end + 1;
    } else {
      re += rest[0].replace(REGEX_CHARS, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesSource(source, pathname) {
  return sourceToRegExp(source).test(pathname);
}

// Filesystem lookup used for both requests and rewrite destinations.
// With cleanUrls, Vercel only serves "x.html" through the clean path "/x", so a path
// (or rewrite destination) that still ends in ".html" finds nothing.
function findFile(path, config, isFile) {
  if (path.endsWith('/')) return isFile(`${path}index.html`) ? `${path}index.html` : null;
  if (config.cleanUrls && path.endsWith('.html')) return null;
  if (isFile(path)) return path;
  if (config.cleanUrls && isFile(`${path}.html`)) return `${path}.html`;
  return null;
}

// isFile(path) answers whether a file exists at that site path (e.g. "/css/base.css").
// Returns { type: 'file', path } | { type: 'redirect', location } | { type: 'notFound' }.
export function resolveRequest(pathname, config, isFile) {
  if (config.cleanUrls && pathname.endsWith('.html')) {
    let location = pathname.slice(0, -'.html'.length);
    if (location.endsWith('/index')) location = location.slice(0, -'index'.length);
    return { type: 'redirect', location: location || '/' };
  }

  const direct = findFile(pathname, config, isFile);
  if (direct) return { type: 'file', path: direct };

  for (const rule of config.rewrites ?? []) {
    if (!matchesSource(rule.source, pathname)) continue;
    const target = findFile(rule.destination, config, isFile);
    if (target) return { type: 'file', path: target };
  }
  return { type: 'notFound' };
}

export function headersFor(pathname, config) {
  const out = {};
  for (const rule of config.headers ?? []) {
    if (!matchesSource(rule.source, pathname)) continue;
    for (const { key, value } of rule.headers) out[key] = value;
  }
  return out;
}
