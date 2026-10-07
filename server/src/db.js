// The rt server's only database client: service_role, fixed to the jigsaw schema.
// The service role key comes from the environment (/etc/jigsaw-rt.env) and never leaves
// server/ (spec D16). No code here reaches another schema of the shared gyosil project.
import { createClient } from '@supabase/supabase-js';

export const DB_SCHEMA = 'jigsaw';

export function createDbClient({ url, serviceRoleKey }) {
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
  }
  return createClient(url, serviceRoleKey, {
    db: { schema: DB_SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
