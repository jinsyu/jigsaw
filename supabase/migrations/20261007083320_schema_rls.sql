-- T3: tables, row level security, realtime channel and storage permissions.
--
-- Roles
-- - Teacher: a signed-in user that is not anonymous (JWT claim is_anonymous = false).
--   A teacher sees only the sessions they own and everything under them.
-- - Student: an anonymous user with a members row. A student sees their own
--   session row, their own members row, and the rows of their own group only.
-- - Clients never write puzzle data directly. sessions, groups, members,
--   clusters and pieces change only through security definer RPCs (T4~T6).
--   Teachers may insert and delete their own images rows (T8 upload flow).
--
-- Student names are never stored here (D14): members has no name column on purpose.
-- Coordinates and the picture aspect are float8 and cluster ids are bigint so the
-- SQL snap check (T5) is bit-for-bit identical to public/js/puzzle/snap.js.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.images (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Storage object name in the private "images" bucket.
  path text not null generated always as (teacher_id::text || '/' || id::text || '.webp') stored,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint images_long_side check (greatest(width, height) <= 2000)
);
create index images_teacher_id_idx on public.images (teacher_id);

create table public.sessions (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references auth.users (id) on delete cascade,
  code text not null check (code ~ '^[0-9]{6}$'),
  -- The picture is either a built-in image key or one of the teacher's images.
  builtin_key text check (builtin_key ~ '^[a-z0-9-]{1,64}$'),
  image_id uuid references public.images (id) on delete set null,
  piece_count smallint not null check (piece_count in (12, 24, 48, 70)),
  cols smallint not null check (cols > 0),
  rows smallint not null check (rows > 0),
  -- Picture width / height, stored exactly as computed in JS.
  aspect double precision not null,
  seed bigint not null check (seed between 1 and 4294967295),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'ended')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  constraint sessions_one_picture check (builtin_key is null or image_id is null),
  constraint sessions_grid check (cols * rows = piece_count),
  -- NaN is greater than every number in Postgres, so "< Infinity" also rejects NaN.
  constraint sessions_aspect_finite check (aspect > 0 and aspect < 'Infinity'::double precision),
  -- Same orientation rule as geometry.gridFor(): landscape or square -> more columns.
  constraint sessions_grid_orientation check ((aspect >= 1) = (cols > rows))
);
create index sessions_teacher_id_idx on public.sessions (teacher_id);
create index sessions_image_id_idx on public.sessions (image_id);
-- A code identifies one open session at a time.
create unique index sessions_open_code_key on public.sessions (code) where status <> 'ended';

create table public.groups (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.sessions (id) on delete cascade,
  number smallint not null check (number >= 1),
  completed_at timestamptz,
  unique (session_id, number),
  -- Target of the composite foreign key from members (group must be in the same session).
  unique (id, session_id)
);

create table public.members (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  group_id bigint,
  color smallint check (color >= 0),
  last_seen timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  unique (session_id, user_id),
  foreign key (group_id, session_id) references public.groups (id, session_id)
    on delete set null (group_id)
);
comment on table public.members is
  'Students in a session. No name column by design: names live only in Realtime Presence and on the device (D14).';
create index members_user_id_idx on public.members (user_id);
create index members_group_id_idx on public.members (group_id);

create table public.clusters (
  id bigint generated always as identity primary key,
  group_id bigint not null references public.groups (id) on delete cascade,
  -- Board position of the picture origin (float8, see geometry.js).
  x double precision not null default 0,
  y double precision not null default 0,
  z integer not null default 0,
  grabbed_by uuid references auth.users (id) on delete set null,
  grabbed_at timestamptz,
  constraint clusters_position_finite check (
    x > '-Infinity'::double precision and x < 'Infinity'::double precision
    and y > '-Infinity'::double precision and y < 'Infinity'::double precision
  ),
  -- Target of the composite foreign key from pieces (cluster must be in the same group).
  unique (id, group_id)
);
create index clusters_group_id_idx on public.clusters (group_id);

create table public.pieces (
  group_id bigint not null references public.groups (id) on delete cascade,
  col smallint not null check (col >= 0),
  "row" smallint not null check ("row" >= 0),
  cluster_id bigint not null,
  -- Tray owner. Null once the piece is on the board (or if the owner account is gone).
  owner_id uuid references auth.users (id) on delete set null,
  on_board boolean not null default false,
  primary key (group_id, "row", col),
  foreign key (cluster_id, group_id) references public.clusters (id, group_id)
);
create index pieces_cluster_id_idx on public.pieces (cluster_id);
create index pieces_owner_id_idx on public.pieces (owner_id);

-- ---------------------------------------------------------------------------
-- Privileges: read-only for signed-in users, nothing for the anon key.
-- ---------------------------------------------------------------------------

revoke all on table
  public.images, public.sessions, public.groups, public.members, public.clusters, public.pieces
  from anon, authenticated;
grant select on table
  public.images, public.sessions, public.groups, public.members, public.clusters, public.pieces
  to authenticated;
grant insert, delete on table public.images to authenticated;
grant all on table
  public.images, public.sessions, public.groups, public.members, public.clusters, public.pieces
  to service_role;

-- ---------------------------------------------------------------------------
-- Exact float8 output.
-- The Supabase Postgres image sets extra_float_digits = 0 in postgresql.conf, so
-- float8 -> text/JSON prints only 15 significant digits (1.7761332099907492 ->
-- 1.77613320999075) in Data API responses and to_jsonb(). Any value >= 1 prints the
-- shortest text that round-trips exactly, which the JS snap parity (T5) relies on.
-- PostgREST applies these role settings when it switches to the request role.
-- SQL functions that turn float8 into JSON or text (realtime.send payloads, T5)
-- should still declare "set extra_float_digits = 1" so they do not depend on the caller.
-- ---------------------------------------------------------------------------

alter role anon set extra_float_digits = 1;
alter role authenticated set extra_float_digits = 1;
alter role service_role set extra_float_digits = 1;
alter role postgres set extra_float_digits = 1;

-- ---------------------------------------------------------------------------
-- Permission helpers (not exposed through the Data API).
-- security definer so policies can look up members/sessions without RLS recursion.
-- ---------------------------------------------------------------------------

create schema private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create function private.is_teacher()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and coalesce(auth.jwt() ->> 'is_anonymous', 'true') = 'false';
$$;

create function private.is_session_teacher(target_session bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_teacher() and exists (
    select 1 from public.sessions s
    where s.id = target_session and s.teacher_id = auth.uid()
  );
$$;

create function private.is_session_member(target_session bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.session_id = target_session and m.user_id = auth.uid()
  );
$$;

create function private.is_group_member(target_group bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.group_id = target_group and m.user_id = auth.uid()
  );
$$;

create function private.is_group_teacher(target_group bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_teacher() and exists (
    select 1 from public.groups g
    join public.sessions s on s.id = g.session_id
    where g.id = target_group and s.teacher_id = auth.uid()
  );
$$;

create function private.can_access_group(target_group bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_group_member(target_group) or private.is_group_teacher(target_group);
$$;

create function private.can_access_session(target_session bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_session_member(target_session) or private.is_session_teacher(target_session);
$$;

-- A student may read an image row / file only while in a session that uses it.
create function private.image_used_by_my_session(target_image uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.sessions s
    join public.members m on m.session_id = s.id
    where s.image_id = target_image and m.user_id = auth.uid()
  );
$$;

create function private.can_read_image_object(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.images i
    where i.path = object_name
      and (
        (i.teacher_id = auth.uid() and private.is_teacher())
        or private.image_used_by_my_session(i.id)
      )
  );
$$;

-- Realtime topics: "group:<id>" (puzzle broadcasts) and "session:<id>" (Presence).
create function private.can_join_topic(topic text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  if topic ~ '^group:[1-9][0-9]{0,17}$' then
    return private.can_access_group(substr(topic, 7)::bigint);
  elsif topic ~ '^session:[1-9][0-9]{0,17}$' then
    return private.can_access_session(substr(topic, 9)::bigint);
  end if;
  return false;
end;
$$;

create function private.can_track_presence(topic text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  if topic ~ '^session:[1-9][0-9]{0,17}$' then
    return private.can_access_session(substr(topic, 9)::bigint);
  end if;
  return false;
end;
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.images enable row level security;
alter table public.sessions enable row level security;
alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.clusters enable row level security;
alter table public.pieces enable row level security;

create policy "teachers read own images, students read their session image"
  on public.images for select to authenticated
  using (
    (teacher_id = (select auth.uid()) and (select private.is_teacher()))
    or private.image_used_by_my_session(id)
  );

create policy "teachers add own images"
  on public.images for insert to authenticated
  with check (teacher_id = (select auth.uid()) and (select private.is_teacher()));

create policy "teachers delete own images"
  on public.images for delete to authenticated
  using (teacher_id = (select auth.uid()) and (select private.is_teacher()));

create policy "teachers read own sessions, students read their session"
  on public.sessions for select to authenticated
  using (
    (teacher_id = (select auth.uid()) and (select private.is_teacher()))
    or private.is_session_member(id)
  );

create policy "teachers read all groups of own sessions, students read their group"
  on public.groups for select to authenticated
  using (private.is_session_teacher(session_id) or private.is_group_member(id));

create policy "students read self and groupmates, teachers read own sessions"
  on public.members for select to authenticated
  using (
    user_id = (select auth.uid())
    or (group_id is not null and private.is_group_member(group_id))
    or private.is_session_teacher(session_id)
  );

create policy "group members and the teacher read clusters"
  on public.clusters for select to authenticated
  using (private.can_access_group(group_id));

create policy "group members and the teacher read pieces"
  on public.pieces for select to authenticated
  using (private.can_access_group(group_id));

-- ---------------------------------------------------------------------------
-- Realtime: private channels only. Clients receive broadcasts and Presence on
-- topics they belong to, and may only track Presence on their session topic.
-- Puzzle broadcasts are sent by RPCs with realtime.send (no client broadcast).
-- ---------------------------------------------------------------------------

create policy "participants receive their group and session topics"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and private.can_join_topic((select realtime.topic()))
  );

create policy "participants track presence on their session topic"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and private.can_track_presence((select realtime.topic()))
  );

-- ---------------------------------------------------------------------------
-- Storage: private bucket "images", objects named <teacher_uid>/<image_id>.webp.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', false, 5242880, array['image/webp'])
on conflict (id) do nothing;

create policy "teachers upload into their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'images'
    and (select private.is_teacher())
    and name ~ (
      '^' || (select auth.uid())::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    )
  );

create policy "teachers read own files, students read their session image"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'images'
    and (
      ((select private.is_teacher()) and (storage.foldername(name))[1] = (select auth.uid())::text)
      or private.can_read_image_object(name)
    )
  );

create policy "teachers delete own files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'images'
    and (select private.is_teacher())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Let a running PostgREST pick up the new role settings and tables.
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
