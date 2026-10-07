import { describe, expect, it } from 'vitest';
import { DB_SCHEMA, IMAGE_BUCKET, groupTopic, sessionTopic } from '../../public/js/supabase-names.js';

// The shared gyosil project: jigsaw's schema, bucket and topics carry the jigsaw prefix, and
// the topics match the realtime.messages policies (jigsaw_private.can_join_topic).
describe('supabase-names', () => {
  it('uses the jigsaw schema and bucket', () => {
    expect(DB_SCHEMA).toBe('jigsaw');
    expect(IMAGE_BUCKET).toBe('jigsaw-images');
  });

  it('builds the private topics the policies accept', () => {
    expect(groupTopic(12)).toBe('jigsaw:group:12');
    expect(sessionTopic(7)).toBe('jigsaw:session:7');
    expect(groupTopic(12)).toMatch(/^jigsaw:group:[1-9][0-9]{0,17}$/);
    expect(sessionTopic(7)).toMatch(/^jigsaw:session:[1-9][0-9]{0,17}$/);
  });
});
