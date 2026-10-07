-- jigsaw (함께 퍼즐) on the shared gyosil project: one schema, reached only by the rt server.
--
-- - Everything lives in schema jigsaw. RLS is on for every table with no policies, and anon,
--   authenticated and PUBLIC get no privilege on the schema or anything in it: the publishable
--   key and signed-in gyosil users get "permission denied" even though jigsaw is in the
--   dashboard's Exposed schemas (the rt server's supabase-js needs it there). Only
--   service_role (the rt server) may read and write.
-- - The rt server's memory is the truth while a class runs; sessions / groups / members are
--   its copy for restarts (groups.board, written behind) and its lists.
-- - Student names are never stored: members has no name column (spec D14).
-- - Storage: private bucket jigsaw-images, no policies (service_role only).
-- - Applied remotely with scripts/db/migrate.sh, which records each file in
--   jigsaw.schema_migrations (created here). Every later migration must revoke the same way
--   for the objects it adds (tests/server/db/permissions.test.js checks every table).
--   Every later migration revokes from public, anon and authenticated and grants service_role
--   directly on each object it creates (do not rely on default privileges alone).

create schema jigsaw;

create table jigsaw.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

-- A gyosil account that started using jigsaw (함께 퍼즐 시작하기).
create table jigsaw.teachers (
  id uuid primary key references auth.users (id) on delete cascade,
  started_at timestamptz not null default now()
);

-- Teachers' own pictures: jigsaw-images/<teacher_id>/<id>.webp
create table jigsaw.images (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references jigsaw.teachers (id) on delete cascade,
  path text not null unique,
  width integer not null check (width between 1 and 2000),
  height integer not null check (height between 1 and 2000),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index images_teacher_idx on jigsaw.images (teacher_id);

create table jigsaw.sessions (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references jigsaw.teachers (id) on delete cascade,
  code text not null check (code ~ '^[0-9]{6}$'),
  -- A built-in picture key or one of the teacher's images. The rt server refuses to delete an
  -- image an open class uses; an ended class only loses the link.
  builtin_key text check (builtin_key ~ '^[a-z0-9-]{1,64}$'),
  image_id uuid references jigsaw.images (id) on delete set null,
  piece_count smallint not null check (piece_count in (12, 24, 48, 70)),
  cols smallint not null check (cols > 0),
  "rows" smallint not null check ("rows" > 0),
  aspect double precision not null check (aspect > 0 and aspect < 'Infinity'),
  seed bigint not null check (seed > 0),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'ended')),
  hint_preview boolean not null default false,
  hint_outline boolean not null default true,
  hint_picture_button boolean not null default true,
  hint_underlay boolean not null default false,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  check (num_nonnulls(builtin_key, image_id) <= 1)
);
-- Codes are unique among open classes only.
create unique index sessions_open_code_idx on jigsaw.sessions (code) where status <> 'ended';
create index sessions_teacher_idx on jigsaw.sessions (teacher_id);
create index sessions_image_idx on jigsaw.sessions (image_id);

-- One row per group. board = the rt server's board copy (clusters and trays, member ids only),
-- null until the group has a puzzle.
create table jigsaw.groups (
  session_id uuid not null references jigsaw.sessions (id) on delete cascade,
  number smallint not null check (number between 1 and 12),
  completed_at timestamptz,
  board jsonb,
  updated_at timestamptz not null default now(),
  primary key (session_id, number)
);

-- Students of an open class. No name. token_hash = sha256 of the student's token (hex).
create table jigsaw.members (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references jigsaw.sessions (id) on delete cascade,
  group_number smallint,
  color smallint check (color >= 0),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  joined_at timestamptz not null default now(),
  foreign key (session_id, group_number) references jigsaw.groups (session_id, number)
);
create index members_session_idx on jigsaw.members (session_id);

-- Privileges: rt server only.
alter table jigsaw.schema_migrations enable row level security;
alter table jigsaw.teachers enable row level security;
alter table jigsaw.images enable row level security;
alter table jigsaw.sessions enable row level security;
alter table jigsaw.groups enable row level security;
alter table jigsaw.members enable row level security;

revoke all on schema jigsaw from public, anon, authenticated;
revoke all on all tables in schema jigsaw from public, anon, authenticated;
revoke all on all sequences in schema jigsaw from public, anon, authenticated;
revoke all on all routines in schema jigsaw from public, anon, authenticated;
-- Objects created later in this schema by the migrating role start closed too.
alter default privileges in schema jigsaw revoke all on tables from public, anon, authenticated;
alter default privileges in schema jigsaw revoke all on sequences from public, anon, authenticated;
alter default privileges in schema jigsaw revoke all on routines from public, anon, authenticated;

grant usage on schema jigsaw to service_role;
grant select, insert, update, delete on all tables in schema jigsaw to service_role;
grant usage, select on all sequences in schema jigsaw to service_role;

-- Private bucket; no storage.objects policy mentions it, so only service_role reaches it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('jigsaw-images', 'jigsaw-images', false, 3145728, array['image/webp'])
on conflict (id) do nothing;
