// Screen routes. Paths here must also be rewritten to index.html in vercel.json.
const ROUTES = [
  { name: 'home', pattern: /^\/$/ },
  { name: 'join', pattern: /^\/join$/ },
  { name: 'play', pattern: /^\/play$/ },
  { name: 'teacher', pattern: /^\/teacher(?:\/.*)?$/ },
];

export function matchRoute(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const route = ROUTES.find((r) => r.pattern.test(path));
  return route ? route.name : 'notFound';
}

// Keep only digits, at most 6, for the class code field.
export function normalizeCode(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 6);
}
