// Views under /teacher. The top-level router (js/routes.js) sends every /teacher path here.
const SESSION_PATH = /^\/teacher\/sessions\/([1-9]\d{0,14})$/;

export function parseTeacherPath(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/teacher') return { view: 'home' };
  if (path === '/teacher/new') return { view: 'new' };
  if (path === '/teacher/images') return { view: 'images' };
  const match = path.match(SESSION_PATH);
  if (match) return { view: 'session', sessionId: Number(match[1]) };
  return { view: 'notFound' };
}

export function sessionPath(id) {
  return `/teacher/sessions/${id}`;
}
