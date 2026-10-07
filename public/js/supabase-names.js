// Names of jigsaw's objects in the shared gyosil Supabase project. Every service there has
// its own schema, Storage bucket and Realtime topic prefix (supabase/migrations/*_jigsaw_*).

// Tables and RPCs (supabase-js `db.schema`).
export const DB_SCHEMA = 'jigsaw';

// Private bucket for teachers' pictures, objects named <teacher_uid>/<image_id>.webp.
export const IMAGE_BUCKET = 'jigsaw-images';

// Private Realtime topics: puzzle broadcasts per group, class events and Presence per session.
export const groupTopic = (groupId) => `jigsaw:group:${groupId}`;
export const sessionTopic = (sessionId) => `jigsaw:session:${sessionId}`;
