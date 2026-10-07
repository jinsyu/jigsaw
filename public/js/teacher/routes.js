// Views under /teacher. The top-level router (js/routes.js) sends every /teacher path here.
// Class ids are the rt server's UUIDs (server/src/engine/registry.js).
const SESSION_PATH = /^\/teacher\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function parseTeacherPath(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/teacher') return { view: 'home' };
  if (path === '/teacher/new') return { view: 'new' };
  if (path === '/teacher/images') return { view: 'images' };
  const match = path.match(SESSION_PATH);
  if (match) return { view: 'session', sessionId: match[1].toLowerCase() };
  return { view: 'notFound' };
}

export function sessionPath(id) {
  return `/teacher/sessions/${id}`;
}
