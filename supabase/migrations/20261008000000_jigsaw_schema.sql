-- jigsaw (함께 퍼즐) on the shared gyosil Supabase project.
--
-- Every service of the gyosil project keeps its objects in its own schema. jigsaw uses
-- - jigsaw          tables and the RPCs called through the Data API (exposed schema)
-- - jigsaw_private  helpers for policies and RPCs, never exposed through the Data API
-- and touches shared objects only with jigsaw-named entries: realtime.messages policies
-- (jigsaw_*, topics jigsaw:*), the Storage bucket jigsaw-images (policies jigsaw_*) and
-- the pg_cron job jigsaw-cleanup. No role or database setting is changed.
--
-- Roles
-- - Teacher: a signed-in user that is not anonymous (JWT claim is_anonymous = false).
--   A teacher sees only the sessions they own and everything under them.
-- - Student: an anonymous user with a members row. A student sees their own
--   session row, their own members row, and the rows of their own group only.
-- - Clients never write puzzle data directly. sessions, groups, members,
--   clusters and pieces change only through security definer RPCs.
--   Teachers may insert and delete their own images rows (upload flow).
--
-- Student names are never stored here (D14): members has no name column on purpose.
-- Coordinates and the picture aspect are float8 and cluster ids are bigint so the
-- SQL snap check is bit-for-bit identical to public/js/puzzle/snap.js.
--
-- Exact float8 output: the Supabase image sets extra_float_digits = 0, so float8 -> text or
-- JSON prints only 15 significant digits (1.7761332099907492 -> 1.77613320999075). Nothing
-- here changes role settings (the project is shared). Every function that turns float8 into
-- JSON declares "set extra_float_digits = 1", and clients read coordinates and the picture
-- aspect through such RPCs (load_board, session_setup, session_overview, the puzzle RPCs),
-- never with a plain table select.

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------

create schema jigsaw;
revoke all on schema jigsaw from public;
grant usage on schema jigsaw to anon, authenticated, service_role;

-- Not in the Data API's exposed schemas. authenticated needs usage (and execute on the
-- policy helpers below) because row level security policies run as the requesting role;
-- every other function in it is revoked from the API roles.
create schema jigsaw_private;
revoke all on schema jigsaw_private from public;
grant usage on schema jigsaw_private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table jigsaw.images (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Storage object name in the private "jigsaw-images" bucket.
  path text not null generated always as (teacher_id::text || '/' || id::text || '.webp') stored,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint images_long_side check (greatest(width, height) <= 2000)
);
create index images_teacher_id_idx on jigsaw.images (teacher_id);

create table jigsaw.sessions (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references auth.users (id) on delete cascade,
  code text not null check (code ~ '^[0-9]{6}$'),
  -- The picture is either a built-in image key or one of the teacher's images.
  builtin_key text check (builtin_key ~ '^[a-z0-9-]{1,64}$'),
  image_id uuid references jigsaw.images (id) on delete set null,
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
  -- Show where a dragged piece would snap (snapping itself always works).
  hint_preview boolean not null default false,
  -- Piece outlines inside the frame (off: the frame border only).
  hint_outline boolean not null default true,
  -- The "completed picture" button on the student screen.
  hint_picture_button boolean not null default true,
  -- The completed picture very faint inside the frame.
  hint_underlay boolean not null default false,
  constraint sessions_one_picture check (builtin_key is null or image_id is null),
  constraint sessions_grid check (cols * rows = piece_count),
  -- NaN is greater than every number in Postgres, so "< Infinity" also rejects NaN.
  constraint sessions_aspect_finite check (aspect > 0 and aspect < 'Infinity'::double precision),
  -- Same orientation rule as geometry.gridFor(): landscape or square -> more columns.
  constraint sessions_grid_orientation check ((aspect >= 1) = (cols > rows))
);
create index sessions_teacher_id_idx on jigsaw.sessions (teacher_id);
create index sessions_image_id_idx on jigsaw.sessions (image_id);
-- A code identifies one open session at a time.
create unique index sessions_open_code_key on jigsaw.sessions (code) where status <> 'ended';

create table jigsaw.groups (
  id bigint generated always as identity primary key,
  session_id bigint not null references jigsaw.sessions (id) on delete cascade,
  number smallint not null check (number >= 1),
  completed_at timestamptz,
  unique (session_id, number),
  -- Target of the composite foreign key from members (group must be in the same session).
  unique (id, session_id)
);

create table jigsaw.members (
  id bigint generated always as identity primary key,
  session_id bigint not null references jigsaw.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  group_id bigint,
  color smallint check (color >= 0),
  last_seen timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  unique (session_id, user_id),
  foreign key (group_id, session_id) references jigsaw.groups (id, session_id)
    on delete set null (group_id)
);
comment on table jigsaw.members is
  'Students in a session. No name column by design: names live only in Realtime Presence and on the device (D14).';
create index members_user_id_idx on jigsaw.members (user_id);
create index members_group_id_idx on jigsaw.members (group_id);

create table jigsaw.clusters (
  id bigint generated always as identity primary key,
  group_id bigint not null references jigsaw.groups (id) on delete cascade,
  -- Board position of the picture origin (float8, see geometry.js).
  x double precision not null default 0,
  y double precision not null default 0,
  z integer not null default 0,
  grabbed_by uuid references auth.users (id) on delete set null,
  grabbed_at timestamptz,
  locked boolean not null default false,
  constraint clusters_position_finite check (
    x > '-Infinity'::double precision and x < 'Infinity'::double precision
    and y > '-Infinity'::double precision and y < 'Infinity'::double precision
  ),
  -- Target of the composite foreign key from pieces (cluster must be in the same group).
  unique (id, group_id)
);
create index clusters_group_id_idx on jigsaw.clusters (group_id);

create table jigsaw.pieces (
  group_id bigint not null references jigsaw.groups (id) on delete cascade,
  col smallint not null check (col >= 0),
  "row" smallint not null check ("row" >= 0),
  cluster_id bigint not null,
  -- Tray owner. Null once the piece is on the board (or if the owner account is gone).
  owner_id uuid references auth.users (id) on delete set null,
  on_board boolean not null default false,
  primary key (group_id, "row", col),
  foreign key (cluster_id, group_id) references jigsaw.clusters (id, group_id)
);
create index pieces_cluster_id_idx on jigsaw.pieces (cluster_id);
create index pieces_owner_id_idx on jigsaw.pieces (owner_id);

comment on column jigsaw.clusters.locked is
  'Snapped into the frame (completed picture position): fixed for good, cannot be grabbed.';

-- Anonymous accounts that used jigsaw (join_session), so automatic cleanup deletes only
-- jigsaw student accounts and never another service's users of the shared project.
create table jigsaw_private.student_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Failed join_session codes per account, for the short lockout.
create table jigsaw_private.join_failures (
  user_id uuid not null references auth.users (id) on delete cascade,
  failed_at timestamptz not null default now()
);
create index join_failures_user_idx on jigsaw_private.join_failures (user_id, failed_at);

-- ---------------------------------------------------------------------------
-- Privileges: read-only for signed-in users, nothing for the anon key.
-- ---------------------------------------------------------------------------

revoke all on table
  jigsaw.images, jigsaw.sessions, jigsaw.groups, jigsaw.members, jigsaw.clusters, jigsaw.pieces
  from anon, authenticated;
grant select on table
  jigsaw.images, jigsaw.sessions, jigsaw.groups, jigsaw.members, jigsaw.clusters, jigsaw.pieces
  to authenticated;
grant insert, delete on table jigsaw.images to authenticated;
grant all on table
  jigsaw.images, jigsaw.sessions, jigsaw.groups, jigsaw.members, jigsaw.clusters, jigsaw.pieces
  to service_role;

revoke all on table jigsaw_private.student_accounts, jigsaw_private.join_failures
  from public, anon, authenticated;
grant all on table jigsaw_private.student_accounts, jigsaw_private.join_failures to service_role;

-- ---------------------------------------------------------------------------
-- Permission helpers (not exposed through the Data API).
-- security definer so policies can look up members/sessions without RLS recursion.
-- ---------------------------------------------------------------------------

create function jigsaw_private.is_teacher()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and coalesce(auth.jwt() ->> 'is_anonymous', 'true') = 'false';
$$;

create function jigsaw_private.is_session_teacher(target_session bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select jigsaw_private.is_teacher() and exists (
    select 1 from jigsaw.sessions s
    where s.id = target_session and s.teacher_id = auth.uid()
  );
$$;

create function jigsaw_private.is_session_member(target_session bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from jigsaw.members m
    where m.session_id = target_session and m.user_id = auth.uid()
  );
$$;

create function jigsaw_private.is_group_member(target_group bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from jigsaw.members m
    where m.group_id = target_group and m.user_id = auth.uid()
  );
$$;

create function jigsaw_private.is_group_teacher(target_group bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select jigsaw_private.is_teacher() and exists (
    select 1 from jigsaw.groups g
    join jigsaw.sessions s on s.id = g.session_id
    where g.id = target_group and s.teacher_id = auth.uid()
  );
$$;

create function jigsaw_private.can_access_group(target_group bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select jigsaw_private.is_group_member(target_group) or jigsaw_private.is_group_teacher(target_group);
$$;

create function jigsaw_private.can_access_session(target_session bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select jigsaw_private.is_session_member(target_session) or jigsaw_private.is_session_teacher(target_session);
$$;

-- A student may read an image row / file only while in a session that uses it.
create function jigsaw_private.image_used_by_my_session(target_image uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from jigsaw.sessions s
    join jigsaw.members m on m.session_id = s.id
    where s.image_id = target_image and m.user_id = auth.uid()
  );
$$;

create function jigsaw_private.can_read_image_object(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from jigsaw.images i
    where i.path = object_name
      and (
        (i.teacher_id = auth.uid() and jigsaw_private.is_teacher())
        or jigsaw_private.image_used_by_my_session(i.id)
      )
  );
$$;

-- Realtime topics: "jigsaw:group:<id>" (puzzle broadcasts) and "jigsaw:session:<id>" (Presence).
create function jigsaw_private.can_join_topic(topic text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  if topic ~ '^jigsaw:group:[1-9][0-9]{0,17}$' then
    return jigsaw_private.can_access_group(substr(topic, 14)::bigint);
  elsif topic ~ '^jigsaw:session:[1-9][0-9]{0,17}$' then
    return jigsaw_private.can_access_session(substr(topic, 16)::bigint);
  end if;
  return false;
end;
$$;

create function jigsaw_private.can_track_presence(topic text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  if topic ~ '^jigsaw:session:[1-9][0-9]{0,17}$' then
    return jigsaw_private.can_access_session(substr(topic, 16)::bigint);
  end if;
  return false;
end;
$$;

-- A picture used by an open class (status <> 'ended') cannot be deleted: neither the
-- images row nor its Storage file (policies below and in jigsaw_realtime_storage).

-- True while a session that is not ended uses the image.
create function jigsaw_private.image_in_open_session(target_image uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from jigsaw.sessions s
    where s.image_id = target_image and s.status <> 'ended'
  );
$$;

-- The same for a Storage object name (<teacher_uid>/<image_id>.webp).
create function jigsaw_private.image_object_in_open_session(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from jigsaw.images i
    join jigsaw.sessions s on s.image_id = i.id
    where i.path = object_name and s.status <> 'ended'
  );
$$;

revoke all on all functions in schema jigsaw_private from public, anon;
grant execute on all functions in schema jigsaw_private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table jigsaw.images enable row level security;
alter table jigsaw.sessions enable row level security;
alter table jigsaw.groups enable row level security;
alter table jigsaw.members enable row level security;
alter table jigsaw.clusters enable row level security;
alter table jigsaw.pieces enable row level security;

create policy "teachers read own images, students read their session image"
  on jigsaw.images for select to authenticated
  using (
    (teacher_id = (select auth.uid()) and (select jigsaw_private.is_teacher()))
    or jigsaw_private.image_used_by_my_session(id)
  );

create policy "teachers add own images"
  on jigsaw.images for insert to authenticated
  with check (teacher_id = (select auth.uid()) and (select jigsaw_private.is_teacher()));

create policy "teachers delete own images not used by an open class"
  on jigsaw.images for delete to authenticated
  using (
    teacher_id = (select auth.uid())
    and (select jigsaw_private.is_teacher())
    and not jigsaw_private.image_in_open_session(id)
  );

create policy "teachers read own sessions, students read their session"
  on jigsaw.sessions for select to authenticated
  using (
    (teacher_id = (select auth.uid()) and (select jigsaw_private.is_teacher()))
    or jigsaw_private.is_session_member(id)
  );

create policy "teachers read all groups of own sessions, students read their group"
  on jigsaw.groups for select to authenticated
  using (jigsaw_private.is_session_teacher(session_id) or jigsaw_private.is_group_member(id));

create policy "students read self and groupmates, teachers read own sessions"
  on jigsaw.members for select to authenticated
  using (
    user_id = (select auth.uid())
    or (group_id is not null and jigsaw_private.is_group_member(group_id))
    or jigsaw_private.is_session_teacher(session_id)
  );

create policy "group members and the teacher read clusters"
  on jigsaw.clusters for select to authenticated
  using (jigsaw_private.can_access_group(group_id));

create policy "group members and the teacher read pieces"
  on jigsaw.pieces for select to authenticated
  using (jigsaw_private.can_access_group(group_id));

notify pgrst, 'reload schema';
