-- Realtime and Storage permissions. Both live in shared tables of the gyosil project, so
-- every entry is named jigsaw_* and matches only jigsaw objects:
-- - realtime.messages policies apply to topics starting with "jigsaw:" only
--   (jigsaw:group:<id> puzzle broadcasts, jigsaw:session:<id> class events and Presence).
--   Policies are permissive (OR), so they add nothing for other services' topics.
-- - Storage: the private bucket jigsaw-images, objects named <teacher_uid>/<image_id>.webp.
--   Policies check bucket_id = 'jigsaw-images' first.

-- ---------------------------------------------------------------------------
-- Realtime: private channels only. Clients receive broadcasts and Presence on
-- topics they belong to, and may only track Presence on their session topic.
-- Puzzle broadcasts are sent by RPCs with realtime.send (no client broadcast).
-- ---------------------------------------------------------------------------

create policy "jigsaw_receive_group_and_session_topics"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and (select realtime.topic()) like 'jigsaw:%'
    and jigsaw_private.can_join_topic((select realtime.topic()))
  );

create policy "jigsaw_track_presence_on_session_topic"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) like 'jigsaw:%'
    and jigsaw_private.can_track_presence((select realtime.topic()))
  );

-- ---------------------------------------------------------------------------
-- Storage: private bucket "jigsaw-images", objects named <teacher_uid>/<image_id>.webp.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('jigsaw-images', 'jigsaw-images', false, 5242880, array['image/webp'])
on conflict (id) do nothing;

create policy "jigsaw_teachers_upload_own_folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'jigsaw-images'
    and (select jigsaw_private.is_teacher())
    and name ~ (
      '^' || (select auth.uid())::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    )
  );

create policy "jigsaw_read_own_files_or_session_image"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'jigsaw-images'
    and (
      ((select jigsaw_private.is_teacher()) and (storage.foldername(name))[1] = (select auth.uid())::text)
      or jigsaw_private.can_read_image_object(name)
    )
  );

-- A picture used by an open class cannot be deleted (also the images row, jigsaw_schema).
create policy "jigsaw_delete_own_files_not_in_open_class"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'jigsaw-images'
    and (select jigsaw_private.is_teacher())
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not jigsaw_private.image_object_in_open_session(name)
  );
