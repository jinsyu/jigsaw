-- T4: class flow RPCs (create, join, group assignment, start, end) and automatic cleanup.
--
-- Errors
-- - join_session never raises for a wrong code: it returns { ok: false, error } so the
--   failed attempt it records is committed (a raised error would roll it back).
--     error = 'invalid_code'       wrong code, or the session has ended
--     error = 'too_many_attempts'  10 or more failed codes in the last minute
-- - Every other refusal raises; the client reads error.code / error.message:
--     42501 forbidden              not a teacher / not this session's teacher / not a student
--     22023 invalid_piece_count | invalid_group_count | invalid_picture | invalid_group | member_not_found
--     55000 session_not_waiting | session_ended
--
-- Broadcasts (realtime.send, private topics from T3)
--   session:<id>  'groups' { members: [{ member_id, group_id, color }] }  assignment changed
--   session:<id>  'start'  { session_id, started_at }
--   session:<id>  'end'    { session_id }                 also sent to every group:<id>
--   group:<id>    'tray'   { pieces: [{ col, row, owner }] }  tray owners changed
--   group:<id>    'release' { clusters: [id, ...] }        grabs dropped when a student moved away
-- Payloads carry ids only (no names, no float8), so no extra_float_digits setting is needed.
--
-- Grid and pieces follow public/js/puzzle/geometry.js: gridFor(pieceCount, aspect) picks
-- cols x rows, and a group's puzzle has one pieces row per cell (col 0..cols-1, row 0..rows-1),
-- each in its own single-piece cluster. Tray pieces are not on the board, so their cluster
-- position stays (0, 0) until take_from_tray (T5) places them.
--
-- Realtime permission cache: Realtime checks realtime.messages policies when a channel is
-- joined, not for every message. A student who moves to another group (or whose session
-- ends) keeps receiving the topics joined before. tests/db/session-flow.test.js records this:
-- clients must leave group:<old> and join group:<new> when they receive 'groups', and leave
-- everything on 'end'. A new join to the old topic is refused.

-- ---------------------------------------------------------------------------
-- Internal helpers (private schema, not callable by API roles)
-- ---------------------------------------------------------------------------

-- Same table as geometry.gridFor(): landscape (aspect >= 1) uses the long side as columns.
create function private.grid_for(p_piece_count integer, p_aspect double precision,
                                 out cols smallint, out rows smallint)
language plpgsql immutable set search_path = ''
as $$
declare
  long_side smallint;
  short_side smallint;
begin
  case p_piece_count
    when 12 then long_side := 4; short_side := 3;
    when 24 then long_side := 6; short_side := 4;
    when 48 then long_side := 8; short_side := 6;
    when 70 then long_side := 10; short_side := 7;
    else raise exception 'invalid_piece_count' using errcode = '22023';
  end case;
  if p_aspect is null or not (p_aspect > 0 and p_aspect < 'Infinity'::double precision) then
    raise exception 'invalid_picture' using errcode = '22023';
  end if;
  if p_aspect >= 1 then
    cols := long_side; rows := short_side;
  else
    cols := short_side; rows := long_side;
  end if;
end;
$$;

-- Unbiased enough for codes and seeds; gen_random_bytes is cryptographically random.
create function private.random_uint32()
returns bigint
language sql volatile set search_path = ''
as $$
  select ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
$$;

-- A student counts as connected when the last signal is at most 15 seconds old (T6 heartbeat).
create function private.online_since()
returns timestamptz
language sql stable set search_path = ''
as $$
  select now() - interval '15 seconds';
$$;

-- Locks the session row and checks that the caller is its teacher.
create function private.lock_own_session(p_session bigint)
returns public.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.sessions;
begin
  if not private.is_teacher() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into s from public.sessions where id = p_session for update;
  if not found or s.teacher_id <> auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return s;
end;
$$;

-- One pieces row per grid cell, each in its own cluster, all in nobody's tray yet.
create function private.create_puzzle(p_group bigint, p_cols smallint, p_rows smallint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  new_cluster bigint;
begin
  for r in 0 .. p_rows - 1 loop
    for c in 0 .. p_cols - 1 loop
      insert into public.clusters (group_id) values (p_group) returning id into new_cluster;
      insert into public.pieces (group_id, col, "row", cluster_id) values (p_group, c, r, new_cluster);
    end loop;
  end loop;
end;
$$;

-- Deals tray pieces (not on the board) of a group to the given students, as evenly as possible.
-- p_from: tray owners whose pieces are dealt, or null for pieces in nobody's tray.
-- Pieces are shuffled and dealt round-robin; students with fewer tray pieces are served first,
-- so the dealt counts differ by at most one. With no receivers the pieces are left in nobody's
-- tray (the next student assigned to the group gets them, see assign_member).
-- Returns the changed pieces as [{ col, row, owner }].
create function private.deal_tray(p_group bigint, p_from uuid[], p_to uuid[])
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dealt jsonb;
begin
  with tray as (
    select p.col, p."row", row_number() over (order by random()) - 1 as i
    from public.pieces p
    where p.group_id = p_group
      and not p.on_board
      and (case when p_from is null then p.owner_id is null else p.owner_id = any (p_from) end)
  ),
  takers as (
    select t.uid,
           row_number() over (order by (
             select count(*) from public.pieces x
             where x.group_id = p_group and x.owner_id = t.uid and not x.on_board
           ), random()) - 1 as j,
           count(*) over () as n
    from (select distinct unnest(p_to) as uid) t
  ),
  plan as (
    select tray.col, tray."row", takers.uid
    from tray left join takers on tray.i % takers.n = takers.j
    where takers.uid is not null or not exists (select 1 from takers)
  ),
  moved as (
    update public.pieces p
    set owner_id = plan.uid
    from plan
    where p.group_id = p_group and p.col = plan.col and p."row" = plan."row"
    returning p.col, p."row", p.owner_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('col', col, 'row', "row", 'owner', owner_id) order by "row", col),
    '[]'::jsonb
  ) into dealt
  from moved;
  return dealt;
end;
$$;

-- Smallest color number not used by another student of the group.
create function private.free_color(p_group bigint, p_member bigint)
returns smallint
language sql stable security definer set search_path = ''
as $$
  select min(c)::smallint
  from generate_series(0, 1000) c
  where not exists (
    select 1 from public.members m
    where m.group_id = p_group and m.color = c and m.id <> p_member
  );
$$;

-- Deletes anonymous accounts that no longer belong to any session.
create function private.delete_orphan_students(p_users uuid[])
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from auth.users u
  where u.id = any (p_users)
    and u.is_anonymous
    and not exists (select 1 from public.members m where m.user_id = u.id);
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- Failed join_session codes per account, for the short lockout.
create table private.join_failures (
  user_id uuid not null references auth.users (id) on delete cascade,
  failed_at timestamptz not null default now()
);
create index join_failures_user_idx on private.join_failures (user_id, failed_at);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Teacher opens a class: picture (built-in key with its aspect, or one of the teacher's
-- images), piece count and group count. Picks a code unused by open sessions and a seed.
create function public.create_session(
  p_piece_count integer,
  p_group_count integer,
  p_builtin_key text default null,
  p_image_id uuid default null,
  p_aspect double precision default null
)
returns public.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  picture_aspect double precision;
  grid record;
  s public.sessions;
  new_seed bigint;
begin
  if not private.is_teacher() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_group_count is null or p_group_count < 1 or p_group_count > 12 then
    raise exception 'invalid_group_count' using errcode = '22023';
  end if;

  if p_image_id is not null and p_builtin_key is null then
    -- Same division as JS (width / height in float64).
    update public.images i set last_used_at = now()
    where i.id = p_image_id and i.teacher_id = auth.uid()
    returning i.width::double precision / i.height::double precision into picture_aspect;
    if picture_aspect is null then
      raise exception 'invalid_picture' using errcode = '22023';
    end if;
  elsif p_builtin_key is not null and p_image_id is null
        and p_builtin_key ~ '^[a-z0-9-]{1,64}$' then
    picture_aspect := p_aspect;
  else
    raise exception 'invalid_picture' using errcode = '22023';
  end if;

  select * into grid from private.grid_for(p_piece_count, picture_aspect);

  for attempt in 1 .. 20 loop
    new_seed := private.random_uint32();
    begin
      insert into public.sessions
        (teacher_id, code, builtin_key, image_id, piece_count, cols, rows, aspect, seed)
      values (
        auth.uid(),
        lpad((private.random_uint32() % 1000000)::text, 6, '0'),
        p_builtin_key, p_image_id, p_piece_count, grid.cols, grid.rows, picture_aspect,
        case when new_seed = 0 then 1 else new_seed end
      )
      returning * into s;
      exit;
    exception when unique_violation then
      -- The code is in use by another open session; draw again.
      null;
    end;
  end loop;
  if s.id is null then
    raise exception 'no_free_code' using errcode = '55000';
  end if;

  insert into public.groups (session_id, number)
  select s.id, n from generate_series(1, p_group_count) n;
  return s;
end;
$$;

-- Student (anonymous account) enters a code. The same account entering again gets its
-- existing members row back, so a reopened device returns to the same group and tray.
create function public.join_session(p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  s public.sessions;
  m public.members;
begin
  if uid is null or coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if (select count(*) from private.join_failures f
      where f.user_id = uid and f.failed_at > now() - interval '1 minute') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;

  -- for share: wait for a concurrent end_session and then see it as ended.
  select * into s from public.sessions
  where code = p_code and status <> 'ended'
  for share;
  if not found then
    insert into private.join_failures (user_id) values (uid);
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  insert into public.members (session_id, user_id)
  values (s.id, uid)
  on conflict (session_id, user_id) do update set last_seen = now()
  returning * into m;

  return jsonb_build_object(
    'ok', true,
    'session_id', s.id,
    'member_id', m.id,
    'group_id', m.group_id,
    'color', m.color,
    'status', s.status
  );
end;
$$;

-- Teacher puts a student into a group (or back to "no group" with null).
-- While playing:
-- - the student's tray pieces in the old group go to the connected students left there
--   (everyone left if nobody is connected, nobody's tray if the group is now empty), and
--   clusters the student was holding are released;
-- - in the new group the student gets no tray, except: a group without a puzzle (empty at
--   start) gets its puzzle now with every piece in this student's tray, and pieces left in
--   nobody's tray go to this student.
create function public.assign_member(p_member bigint, p_group bigint)
returns public.members
language plpgsql volatile security definer set search_path = ''
as $$
declare
  m public.members;
  s public.sessions;
  old_group bigint;
  receivers uuid[];
  dealt jsonb;
  released jsonb;
begin
  select * into m from public.members where id = p_member;
  if not found then
    -- Same answer whether the member is missing or belongs to another teacher.
    if private.is_teacher() then
      raise exception 'member_not_found' using errcode = '22023';
    end if;
    raise exception 'forbidden' using errcode = '42501';
  end if;
  s := private.lock_own_session(m.session_id);
  if s.status = 'ended' then
    raise exception 'session_ended' using errcode = '55000';
  end if;
  if p_group is not null and not exists (
    select 1 from public.groups g where g.id = p_group and g.session_id = s.id
  ) then
    raise exception 'invalid_group' using errcode = '22023';
  end if;

  -- Re-read under the session lock.
  select * into m from public.members where id = p_member;
  old_group := m.group_id;
  if old_group is not distinct from p_group then
    return m;
  end if;

  update public.members
  set group_id = p_group,
      color = case when p_group is null then null else private.free_color(p_group, id) end
  where id = p_member
  returning * into m;

  if s.status = 'playing' then
    if old_group is not null then
      with freed as (
        update public.clusters set grabbed_by = null, grabbed_at = null
        where group_id = old_group and grabbed_by = m.user_id
        returning id
      )
      select jsonb_agg(id order by id) into released from freed;
      if released is not null then
        perform realtime.send(jsonb_build_object('clusters', released), 'release',
                              'group:' || old_group, true);
      end if;

      select coalesce(
        nullif(array_agg(o.user_id) filter (where o.last_seen >= private.online_since()), '{}'),
        array_agg(o.user_id)
      ) into receivers
      from public.members o where o.group_id = old_group;
      dealt := private.deal_tray(old_group, array[m.user_id], receivers);
      if dealt <> '[]'::jsonb then
        perform realtime.send(jsonb_build_object('pieces', dealt), 'tray', 'group:' || old_group, true);
      end if;
    end if;

    if p_group is not null then
      if not exists (select 1 from public.pieces where group_id = p_group) then
        perform private.create_puzzle(p_group, s.cols, s.rows);
      end if;
      dealt := private.deal_tray(p_group, null, array[m.user_id]);
      if dealt <> '[]'::jsonb then
        perform realtime.send(jsonb_build_object('pieces', dealt), 'tray', 'group:' || p_group, true);
      end if;
    end if;
  end if;

  perform realtime.send(
    jsonb_build_object('members', jsonb_build_array(
      jsonb_build_object('member_id', m.id, 'group_id', m.group_id, 'color', m.color))),
    'groups', 'session:' || s.id, true);
  return m;
end;
$$;

-- Teacher shuffles every student of a waiting session into the groups (sizes differ by <= 1).
create function public.randomize_groups(p_session bigint)
returns setof public.members
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.sessions;
  changed jsonb;
begin
  s := private.lock_own_session(p_session);
  if s.status <> 'waiting' then
    raise exception 'session_not_waiting' using errcode = '55000';
  end if;

  with shuffled as (
    select m.id, row_number() over (order by random()) - 1 as i
    from public.members m where m.session_id = s.id
  ),
  numbered as (
    select g.id, row_number() over (order by g.number) - 1 as k, count(*) over () as n
    from public.groups g where g.session_id = s.id
  ),
  placed as (
    select sh.id as member_id, nb.id as group_id,
           (row_number() over (partition by nb.id order by sh.i) - 1)::smallint as color
    from shuffled sh join numbered nb on sh.i % nb.n = nb.k
  )
  update public.members m
  set group_id = placed.group_id, color = placed.color
  from placed where m.id = placed.member_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'member_id', m.id, 'group_id', m.group_id, 'color', m.color) order by m.id), '[]'::jsonb)
  into changed
  from public.members m where m.session_id = s.id;
  perform realtime.send(jsonb_build_object('members', changed), 'groups', 'session:' || s.id, true);

  return query select * from public.members m where m.session_id = s.id order by m.id;
end;
$$;

-- Teacher starts the puzzles: every group with students gets its pieces, dealt evenly to its
-- students (counts differ by <= 1), and colors 0..n-1 in joining order. Groups without
-- students get no puzzle until someone is assigned (see assign_member).
create function public.start_session(p_session bigint)
returns public.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.sessions;
  g record;
begin
  s := private.lock_own_session(p_session);
  if s.status <> 'waiting' then
    raise exception 'session_not_waiting' using errcode = '55000';
  end if;

  update public.sessions set status = 'playing', started_at = now()
  where id = s.id returning * into s;

  for g in
    select gr.id from public.groups gr
    where gr.session_id = s.id
      and exists (select 1 from public.members m where m.group_id = gr.id)
    order by gr.number
  loop
    update public.members m set color = c.color
    from (
      select x.id, (row_number() over (order by x.joined_at, x.id) - 1)::smallint as color
      from public.members x where x.group_id = g.id
    ) c
    where m.id = c.id;
    perform private.create_puzzle(g.id, s.cols, s.rows);
    perform private.deal_tray(
      g.id, null, array(select m.user_id from public.members m where m.group_id = g.id));
  end loop;

  perform realtime.send(jsonb_build_object('session_id', s.id, 'started_at', s.started_at),
                        'start', 'session:' || s.id, true);
  return s;
end;
$$;

-- Teacher ends the class: status ended, members deleted, and the anonymous accounts of those
-- members deleted (unless the same account is still in another session). Every group topic
-- and the session topic get 'end'. Calling it again on an ended session changes nothing.
create function public.end_session(p_session bigint)
returns public.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.sessions;
  students uuid[];
  g record;
begin
  s := private.lock_own_session(p_session);
  if s.status = 'ended' then
    return s;
  end if;

  update public.sessions set status = 'ended', ended_at = now()
  where id = s.id returning * into s;

  with gone as (
    delete from public.members m where m.session_id = s.id returning m.user_id
  )
  select array_agg(user_id) into students from gone;
  perform private.delete_orphan_students(coalesce(students, '{}'));

  update public.clusters c set grabbed_by = null, grabbed_at = null
  from public.groups gr
  where gr.session_id = s.id and c.group_id = gr.id and c.grabbed_by is not null;

  for g in select gr.id from public.groups gr where gr.session_id = s.id order by gr.number loop
    perform realtime.send(jsonb_build_object('session_id', s.id), 'end', 'group:' || g.id, true);
  end loop;
  perform realtime.send(jsonb_build_object('session_id', s.id), 'end', 'session:' || s.id, true);
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Automatic cleanup (pg_cron, hourly)
-- ---------------------------------------------------------------------------

-- 1. Sessions still open 24 hours after creation are ended (the teacher never pressed
--    'end'), so their code is freed and the 30-day deletion below applies.
-- 2. members older than 24 hours (by joined_at) are deleted, and the members of the
--    sessions ended in step 1.
-- 3. Anonymous accounts older than 24 hours with no members row are deleted. This covers
--    students of step 2 and accounts left by failed joins. An older device account that
--    joined a class in the last 24 hours keeps its members row and is kept.
-- 4. Sessions ended more than 30 days ago are deleted (groups, clusters, pieces cascade).
-- 5. join_failures older than one hour are deleted.
-- Teachers' images unused for a year are not deleted here: removing the file needs the
-- Storage API. private.stale_images() lists them (see the T4 report).
create function private.cleanup_expired()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  ended_sessions integer;
  deleted_members integer;
  deleted_students integer;
  deleted_sessions integer;
  expired_ids bigint[];
begin
  with expired as (
    update public.sessions set status = 'ended', ended_at = now()
    where status <> 'ended' and created_at < now() - interval '24 hours'
    returning id
  )
  select array_agg(id) into expired_ids from expired;
  ended_sessions := coalesce(cardinality(expired_ids), 0);

  delete from public.members
  where joined_at < now() - interval '24 hours' or session_id = any (coalesce(expired_ids, '{}'));
  get diagnostics deleted_members = row_count;

  delete from auth.users u
  where u.is_anonymous
    and u.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.members m where m.user_id = u.id);
  get diagnostics deleted_students = row_count;

  delete from public.sessions
  where status = 'ended' and ended_at < now() - interval '30 days';
  get diagnostics deleted_sessions = row_count;

  delete from private.join_failures where failed_at < now() - interval '1 hour';

  return jsonb_build_object(
    'ended_sessions', ended_sessions,
    'deleted_members', deleted_members,
    'deleted_students', deleted_students,
    'deleted_sessions', deleted_sessions
  );
end;
$$;

-- Teacher images not used by any session for a year and not used by an open session.
create function private.stale_images()
returns setof public.images
language sql stable security definer set search_path = ''
as $$
  select i.* from public.images i
  where i.last_used_at < now() - interval '1 year'
    and not exists (
      select 1 from public.sessions s where s.image_id = i.id and s.status <> 'ended'
    );
$$;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('jigsaw-cleanup', '17 * * * *', 'select private.cleanup_expired()');

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table private.join_failures from public, anon, authenticated;

revoke all on function
  private.grid_for(integer, double precision),
  private.random_uint32(),
  private.online_since(),
  private.lock_own_session(bigint),
  private.create_puzzle(bigint, smallint, smallint),
  private.deal_tray(bigint, uuid[], uuid[]),
  private.free_color(bigint, bigint),
  private.delete_orphan_students(uuid[]),
  private.cleanup_expired(),
  private.stale_images()
  from public, anon, authenticated;

revoke all on function
  public.create_session(integer, integer, text, uuid, double precision),
  public.join_session(text),
  public.assign_member(bigint, bigint),
  public.randomize_groups(bigint),
  public.start_session(bigint),
  public.end_session(bigint)
  from public, anon;
grant execute on function
  public.create_session(integer, integer, text, uuid, double precision),
  public.join_session(text),
  public.assign_member(bigint, bigint),
  public.randomize_groups(bigint),
  public.start_session(bigint),
  public.end_session(bigint)
  to authenticated, service_role;

notify pgrst, 'reload schema';
