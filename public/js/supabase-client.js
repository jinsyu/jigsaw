// supabase-js from the CDN, pinned to the same version as the devDependency used by tests.
export const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

// Teachers keep their sign-in under their own key so a student session on the
// same device (anonymous, STUDENT_AUTH_KEY below) never replaces it.
export const TEACHER_AUTH_KEY = 'jigsaw-teacher-auth';

let teacherClientPromise = null;

export function getTeacherClient(config) {
  teacherClientPromise ??= import(SUPABASE_JS_URL).then(({ createClient }) =>
    createClient(config.supabaseUrl, config.publishableKey, {
      auth: {
        storageKey: TEACHER_AUTH_KEY,
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
  );
  return teacherClientPromise;
}

// Students sign in anonymously under their own key. The join address carries ?code=<class
// code>, which supabase-js would otherwise take for an OAuth (PKCE) code, so URL detection
// stays off. PKCE is not used by students at all.
export const STUDENT_AUTH_KEY = 'jigsaw-student-auth';

let studentClientPromise = null;

export function getStudentClient(config) {
  studentClientPromise ??= import(SUPABASE_JS_URL).then(({ createClient }) =>
    createClient(config.supabaseUrl, config.publishableKey, {
      auth: {
        storageKey: STUDENT_AUTH_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    }),
  );
  return studentClientPromise;
}
