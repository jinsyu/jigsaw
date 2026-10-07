// supabase-js for the student screens only (until they move to the rt server in T22), from
// the CDN, pinned to the same version as the devDependency used by tests.
export const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

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
