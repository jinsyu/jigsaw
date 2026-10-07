-- Local-only seed (applied by `pnpm db:reset`, never pushed to the hosted project).
-- Two test teachers with email + password sign-in for DB tests and E2E.
-- Real teachers sign in with Google; these accounts exist only in the local stack.
--   teacher1@jigsaw.test / local-teacher-only
--   teacher2@jigsaw.test / local-teacher-only

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000', t.id, 'authenticated', 'authenticated', t.email,
  extensions.crypt('local-teacher-only', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now(),
  '', '', '', '', '', '', '', ''
from (values
  ('11111111-1111-4111-8111-111111111111'::uuid, 'teacher1@jigsaw.test'),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'teacher2@jigsaw.test')
) as t (id, email);

insert into auth.identities (
  id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(), u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  now(), now(), now()
from auth.users u
where u.email in ('teacher1@jigsaw.test', 'teacher2@jigsaw.test');

-- jigsaw (new structure, T17): both test teachers have started using jigsaw.
insert into jigsaw.teachers (id)
select u.id from auth.users u
where u.email in ('teacher1@jigsaw.test', 'teacher2@jigsaw.test');

-- Local stand-in for the shared gyosil core.profiles table, which already exists on the hosted
-- project (platform.md). Seed only, never in a jigsaw migration. Same columns as the hosted
-- table (checked read-only on the hosted project before T20).
create schema if not exists core;
create table if not exists core.profiles (
  id uuid primary key references auth.users (id),
  display_name text,
  terms_agreed_at timestamptz default now(),
  created_at timestamptz default now()
);
alter table core.profiles enable row level security;
revoke all on schema core from public, anon, authenticated;
revoke all on all tables in schema core from public, anon, authenticated;
grant usage on schema core to service_role;
grant select, insert, update on core.profiles to service_role;
