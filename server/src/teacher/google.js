// Google sign-in for teachers (platform.md 2.2): the screen sends the GIS ID token and the raw
// nonce; Supabase Auth (gyosil project, publishable key) checks both and says which gyosil
// account it is. Kept as one function so tests can pass a fake.
//
// Decision (T20): right after reading the user, the Supabase session made by this sign-in is
// signed out with scope 'local'. The rt server issues its own teacher token and never uses
// Supabase sessions, so no unused refresh token is left behind. 'local' revokes only this
// sign-in's session, not the teacher's sessions in other gyosil apps.
import { createClient } from '@supabase/supabase-js';

export class GoogleSignInError extends Error {}

export function createGoogleVerifier({ supabaseUrl, anonKey }) {
  return async function verifyIdToken({ idToken, nonce }) {
    if (!anonKey) throw new Error('SUPABASE_ANON_KEY 가 필요합니다.');
    const client = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithIdToken({ provider: 'google', token: idToken, nonce });
    if (error || !data?.user) throw new GoogleSignInError(error?.code ?? 'invalid_id_token');
    await client.auth.signOut({ scope: 'local' }).catch(() => {});
    return { uid: data.user.id, email: data.user.email ?? null };
  };
}
