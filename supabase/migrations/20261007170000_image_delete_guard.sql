-- A picture used by an open class (status <> 'ended') cannot be deleted: neither the
-- images row nor its Storage file. The teacher screen checks this first and explains;
-- these policies make sure a direct API call cannot break a running class either.

-- True while a session that is not ended uses the image.
create function private.image_in_open_session(target_image uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.sessions s
    where s.image_id = target_image and s.status <> 'ended'
  );
$$;

-- The same for a Storage object name (<teacher_uid>/<image_id>.webp).
create function private.image_object_in_open_session(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.images i
    join public.sessions s on s.image_id = i.id
    where i.path = object_name and s.status <> 'ended'
  );
$$;

revoke all on function private.image_in_open_session(uuid) from public, anon;
revoke all on function private.image_object_in_open_session(text) from public, anon;
grant execute on function private.image_in_open_session(uuid) to authenticated, service_role;
grant execute on function private.image_object_in_open_session(text) to authenticated, service_role;

drop policy "teachers delete own images" on public.images;
create policy "teachers delete own images not used by an open class"
  on public.images for delete to authenticated
  using (
    teacher_id = (select auth.uid())
    and (select private.is_teacher())
    and not private.image_in_open_session(id)
  );

drop policy "teachers delete own files" on storage.objects;
create policy "teachers delete own files not used by an open class"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'images'
    and (select private.is_teacher())
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not private.image_object_in_open_session(name)
  );

notify pgrst, 'reload schema';
