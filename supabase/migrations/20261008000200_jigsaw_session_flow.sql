-- Class flow RPCs (create, join, group assignment, start, end).
--
-- Errors
-- - join_session never raises for a wrong code: it returns { ok: false, error } so the
--   failed attempt it records is committed (a raised error would roll it back).
--     error = 'invalid_code'       wrong code, or the session has ended
--     error = 'account_gone'       the account was deleted (sign in anonymously again)
--     error = 'too_many_attempts'  10 or more failed codes in the last minute
-- - Every other refusal raises; the client reads error.code / error.message:
--     42501 forbidden              not a teacher / not this session's teacher / not a student
--     22023 invalid_piece_count | invalid_group_count | invalid_picture | invalid_group | member_not_found
--     55000 session_not_waiting | session_ended
--
-- Broadcasts (realtime.send, private topics, see jigsaw_realtime_storage)
--   jigsaw:session:<id>  'groups' { members: [{ member_id, group_id, color }] }  assignment changed
--   jigsaw:session:<id>  'start'  { session_id, started_at }
--   jigsaw:session:<id>  'end'    { session_id }                 also sent to every jigsaw:group:<id>
--   jigsaw:group:<id>    'tray'   { pieces: [{ col, row, owner }] }  tray owners changed
--   jigsaw:group:<id>    'release' { clusters: [id, ...] }        grabs dropped when a student moved away
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
-- clients must leave jigsaw:group:<old> and join jigsaw:group:<new> when they receive 'groups', and leave
-- everything on 'end'. A new join to the old topic is refused.

-- ---------------------------------------------------------------------------
-- Internal helpers (private schema, not callable by API roles)
-- ---------------------------------------------------------------------------

-- Same table as geometry.gridFor(): landscape (aspect >= 1) uses the long side as columns.
create function jigsaw_private.grid_for(p_piece_count integer, p_aspect double precision,
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
create function jigsaw_private.random_uint32()
returns bigint
language sql volatile set search_path = ''
as $$
  select ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
$$;

-- A student counts as connected when the last signal is at most 15 seconds old (T6 heartbeat).
create function jigsaw_private.online_since()
returns timestamptz
language sql stable set search_path = ''
as $$
  select now() - interval '15 seconds';
$$;

-- Locks the session row and checks that the caller is its teacher.
create function jigsaw_private.lock_own_session(p_session bigint)
returns jigsaw.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jigsaw.sessions;
begin
  if not jigsaw_private.is_teacher() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into s from jigsaw.sessions where id = p_session for update;
  if not found or s.teacher_id <> auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return s;
end;
$$;

-- One pieces row per grid cell, each in its own cluster, all in nobody's tray yet.
create function jigsaw_private.create_puzzle(p_group bigint, p_cols smallint, p_rows smallint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  new_cluster bigint;
begin
  for r in 0 .. p_rows - 1 loop
    for c in 0 .. p_cols - 1 loop
      insert into jigsaw.clusters (group_id) values (p_group) returning id into new_cluster;
      insert into jigsaw.pieces (group_id, col, "row", cluster_id) values (p_group, c, r, new_cluster);
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
-- The update re-checks "still in the expected tray and not on the board": under READ
-- COMMITTED a piece taken by a concurrent take_from_tray is re-read after the taker commits,
-- and the re-check skips it instead of giving it an owner again.
create function jigsaw_private.deal_tray(p_group bigint, p_from uuid[], p_to uuid[])
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dealt jsonb;
begin
  with tray as (
    select p.col, p."row", row_number() over (order by random()) - 1 as i
    from jigsaw.pieces p
    where p.group_id = p_group
      and not p.on_board
      and (case when p_from is null then p.owner_id is null else p.owner_id = any (p_from) end)
  ),
  takers as (
    select t.uid,
           row_number() over (order by (
             select count(*) from jigsaw.pieces x
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
    update jigsaw.pieces p
    set owner_id = plan.uid
    from plan
    where p.group_id = p_group and p.col = plan.col and p."row" = plan."row"
      and not p.on_board
      and (case when p_from is null then p.owner_id is null else p.owner_id = any (p_from) end)
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
create function jigsaw_private.free_color(p_group bigint, p_member bigint)
returns smallint
language sql stable security definer set search_path = ''
as $$
  select min(c)::smallint
  from generate_series(0, 1000) c
  where not exists (
    select 1 from jigsaw.members m
    where m.group_id = p_group and m.color = c and m.id <> p_member
  );
$$;

-- Deletes anonymous accounts that no longer belong to any session. Callers pass jigsaw
-- student accounts only (members of a jigsaw class, or jigsaw_private.student_accounts).
-- An account that another service's table still refers to without "on delete cascade" is
-- kept (the delete is skipped) instead of failing the end of a class or the cleanup run.
create function jigsaw_private.delete_orphan_students(p_users uuid[])
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  deleted integer := 0;
  n integer;
  target uuid;
begin
  for target in
    select u.id from auth.users u
    where u.id = any (p_users)
      and u.is_anonymous
      and not exists (select 1 from jigsaw.members m where m.user_id = u.id)
    order by u.id
  loop
    begin
      delete from auth.users u where u.id = target;
      get diagnostics n = row_count;
      deleted := deleted + n;
    exception when foreign_key_violation or restrict_violation then
      null;
    end;
  end loop;
  return deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Teacher opens a class: picture (built-in key with its aspect, or one of the teacher's
-- images), piece count, group count and the help settings. Picks a code unused by open
-- sessions and a seed.
create function jigsaw.create_session(
  p_piece_count integer,
  p_group_count integer,
  p_builtin_key text default null,
  p_image_id uuid default null,
  p_aspect double precision default null,
  p_hint_preview boolean default false,
  p_hint_outline boolean default true,
  p_hint_picture_button boolean default true,
  p_hint_underlay boolean default false
)
returns jigsaw.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  picture_aspect double precision;
  grid record;
  s jigsaw.sessions;
  new_seed bigint;
begin
  if not jigsaw_private.is_teacher() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_group_count is null or p_group_count < 1 or p_group_count > 12 then
    raise exception 'invalid_group_count' using errcode = '22023';
  end if;

  if p_image_id is not null and p_builtin_key is null then
    -- Same division as JS (width / height in float64).
    update jigsaw.images i set last_used_at = now()
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

  select * into grid from jigsaw_private.grid_for(p_piece_count, picture_aspect);

  for attempt in 1 .. 20 loop
    new_seed := jigsaw_private.random_uint32();
    begin
      insert into jigsaw.sessions
        (teacher_id, code, builtin_key, image_id, piece_count, cols, rows, aspect, seed,
         hint_preview, hint_outline, hint_picture_button, hint_underlay)
      values (
        auth.uid(),
        lpad((jigsaw_private.random_uint32() % 1000000)::text, 6, '0'),
        p_builtin_key, p_image_id, p_piece_count, grid.cols, grid.rows, picture_aspect,
        case when new_seed = 0 then 1 else new_seed end,
        -- An explicit null means "default", like a missing argument.
        coalesce(p_hint_preview, false), coalesce(p_hint_outline, true),
        coalesce(p_hint_picture_button, true), coalesce(p_hint_underlay, false)
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

  insert into jigsaw.groups (session_id, number)
  select s.id, n from generate_series(1, p_group_count) n;
  return s;
end;
$$;

-- Student (anonymous account) enters a code. The same account entering again gets its
-- existing members row back, so a reopened device returns to the same group and tray.
-- An account deleted by end_session or cleanup can still hold a valid JWT: it gets
-- { ok: false, error: 'account_gone' } instead of a foreign key error.
create function jigsaw.join_session(p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  s jigsaw.sessions;
  m jigsaw.members;
begin
  if uid is null or coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users u where u.id = uid) then
    return jsonb_build_object('ok', false, 'error', 'account_gone');
  end if;

  -- A jigsaw student account from now on: automatic cleanup may delete it (and only such
  -- accounts) once it is 24 hours old and in no class.
  insert into jigsaw_private.student_accounts (user_id) values (uid) on conflict do nothing;

  if (select count(*) from jigsaw_private.join_failures f
      where f.user_id = uid and f.failed_at > now() - interval '1 minute') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;

  -- for share: wait for a concurrent end_session and then see it as ended.
  select * into s from jigsaw.sessions
  where code = p_code and status <> 'ended'
  for share;
  if not found then
    insert into jigsaw_private.join_failures (user_id) values (uid);
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  insert into jigsaw.members (session_id, user_id)
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
-- While playing it also locks the old and new boards (lock_board, group id order) before
-- releasing grabs or dealing.
create function jigsaw.assign_member(p_member bigint, p_group bigint)
returns jigsaw.members
language plpgsql volatile security definer set search_path = ''
as $$
declare
  m jigsaw.members;
  s jigsaw.sessions;
  old_group bigint;
  receivers uuid[];
  dealt jsonb;
  released jsonb;
  board bigint;
begin
  select * into m from jigsaw.members where id = p_member;
  if not found then
    -- Missing member: member_not_found for a teacher, forbidden for anyone else.
    -- A member of another teacher's session gets forbidden from lock_own_session below.
    if jigsaw_private.is_teacher() then
      raise exception 'member_not_found' using errcode = '22023';
    end if;
    raise exception 'forbidden' using errcode = '42501';
  end if;
  s := jigsaw_private.lock_own_session(m.session_id);
  if s.status = 'ended' then
    raise exception 'session_ended' using errcode = '55000';
  end if;
  if p_group is not null and not exists (
    select 1 from jigsaw.groups g where g.id = p_group and g.session_id = s.id
  ) then
    raise exception 'invalid_group' using errcode = '22023';
  end if;

  -- Re-read under the session lock.
  select * into m from jigsaw.members where id = p_member;
  old_group := m.group_id;
  if old_group is not distinct from p_group then
    return m;
  end if;

  if s.status = 'playing' then
    -- Same lock order as drop / take_from_tray: group rows, then their clusters.
    for board in
      select gid from unnest(array[old_group, p_group]) gid where gid is not null order by gid
    loop
      perform jigsaw_private.lock_board(board);
    end loop;
  end if;

  update jigsaw.members
  set group_id = p_group,
      color = case when p_group is null then null else jigsaw_private.free_color(p_group, id) end
  where id = p_member
  returning * into m;

  if s.status = 'playing' then
    if old_group is not null then
      with freed as (
        update jigsaw.clusters set grabbed_by = null, grabbed_at = null
        where group_id = old_group and grabbed_by = m.user_id
        returning id
      )
      select jsonb_agg(id order by id) into released from freed;
      if released is not null then
        perform realtime.send(jsonb_build_object('clusters', released), 'release',
                              'jigsaw:group:' || old_group, true);
      end if;

      select coalesce(
        nullif(array_agg(o.user_id) filter (where o.last_seen >= jigsaw_private.online_since()), '{}'),
        array_agg(o.user_id)
      ) into receivers
      from jigsaw.members o where o.group_id = old_group;
      dealt := jigsaw_private.deal_tray(old_group, array[m.user_id], receivers);
      if dealt <> '[]'::jsonb then
        perform realtime.send(jsonb_build_object('pieces', dealt), 'tray', 'jigsaw:group:' || old_group, true);
      end if;
    end if;

    if p_group is not null then
      if not exists (select 1 from jigsaw.pieces where group_id = p_group) then
        perform jigsaw_private.create_puzzle(p_group, s.cols, s.rows);
      end if;
      dealt := jigsaw_private.deal_tray(p_group, null, array[m.user_id]);
      if dealt <> '[]'::jsonb then
        perform realtime.send(jsonb_build_object('pieces', dealt), 'tray', 'jigsaw:group:' || p_group, true);
      end if;
    end if;
  end if;

  perform realtime.send(
    jsonb_build_object('members', jsonb_build_array(
      jsonb_build_object('member_id', m.id, 'group_id', m.group_id, 'color', m.color))),
    'groups', 'jigsaw:session:' || s.id, true);
  return m;
end;
$$;

-- Teacher shuffles every student of a waiting session into the groups (sizes differ by <= 1).
create function jigsaw.randomize_groups(p_session bigint)
returns setof jigsaw.members
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jigsaw.sessions;
  changed jsonb;
begin
  s := jigsaw_private.lock_own_session(p_session);
  if s.status <> 'waiting' then
    raise exception 'session_not_waiting' using errcode = '55000';
  end if;

  with shuffled as (
    select m.id, row_number() over (order by random()) - 1 as i
    from jigsaw.members m where m.session_id = s.id
  ),
  numbered as (
    select g.id, row_number() over (order by g.number) - 1 as k, count(*) over () as n
    from jigsaw.groups g where g.session_id = s.id
  ),
  placed as (
    select sh.id as member_id, nb.id as group_id,
           (row_number() over (partition by nb.id order by sh.i) - 1)::smallint as color
    from shuffled sh join numbered nb on sh.i % nb.n = nb.k
  )
  update jigsaw.members m
  set group_id = placed.group_id, color = placed.color
  from placed where m.id = placed.member_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'member_id', m.id, 'group_id', m.group_id, 'color', m.color) order by m.id), '[]'::jsonb)
  into changed
  from jigsaw.members m where m.session_id = s.id;
  perform realtime.send(jsonb_build_object('members', changed), 'groups', 'jigsaw:session:' || s.id, true);

  return query select * from jigsaw.members m where m.session_id = s.id order by m.id;
end;
$$;

-- Teacher starts the puzzles: every group with students gets its pieces, dealt evenly to its
-- students (counts differ by <= 1), and colors 0..n-1 in joining order. Groups without
-- students get no puzzle until someone is assigned (see assign_member).
create function jigsaw.start_session(p_session bigint)
returns jigsaw.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jigsaw.sessions;
  g record;
begin
  s := jigsaw_private.lock_own_session(p_session);
  if s.status <> 'waiting' then
    raise exception 'session_not_waiting' using errcode = '55000';
  end if;

  update jigsaw.sessions set status = 'playing', started_at = now()
  where id = s.id returning * into s;

  for g in
    select gr.id from jigsaw.groups gr
    where gr.session_id = s.id
      and exists (select 1 from jigsaw.members m where m.group_id = gr.id)
    order by gr.number
  loop
    update jigsaw.members m set color = c.color
    from (
      select x.id, (row_number() over (order by x.joined_at, x.id) - 1)::smallint as color
      from jigsaw.members x where x.group_id = g.id
    ) c
    where m.id = c.id;
    perform jigsaw_private.create_puzzle(g.id, s.cols, s.rows);
    perform jigsaw_private.deal_tray(
      g.id, null, array(select m.user_id from jigsaw.members m where m.group_id = g.id));
  end loop;

  perform realtime.send(jsonb_build_object('session_id', s.id, 'started_at', s.started_at),
                        'start', 'jigsaw:session:' || s.id, true);
  return s;
end;
$$;

-- Teacher ends the class: status ended, members deleted, and the anonymous accounts of those
-- members deleted (unless the same account is still in another session). Every group topic
-- and the session topic get 'end'. Calling it again on an ended session changes nothing.
-- Every board of the session is locked first (group id order): deleting the accounts sets
-- clusters.grabbed_by to null ("on delete set null") and grabs are released.
create function jigsaw.end_session(p_session bigint)
returns jigsaw.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jigsaw.sessions;
  students uuid[];
  g record;
begin
  s := jigsaw_private.lock_own_session(p_session);
  if s.status = 'ended' then
    return s;
  end if;

  for g in select gr.id from jigsaw.groups gr where gr.session_id = s.id order by gr.id loop
    perform jigsaw_private.lock_board(g.id);
  end loop;

  update jigsaw.sessions set status = 'ended', ended_at = now()
  where id = s.id returning * into s;

  with gone as (
    delete from jigsaw.members m where m.session_id = s.id returning m.user_id
  )
  select array_agg(user_id) into students from gone;
  perform jigsaw_private.delete_orphan_students(coalesce(students, '{}'));

  update jigsaw.clusters c set grabbed_by = null, grabbed_at = null
  from jigsaw.groups gr
  where gr.session_id = s.id and c.group_id = gr.id and c.grabbed_by is not null;

  for g in select gr.id from jigsaw.groups gr where gr.session_id = s.id order by gr.number loop
    perform realtime.send(jsonb_build_object('session_id', s.id), 'end', 'jigsaw:group:' || g.id, true);
  end loop;
  perform realtime.send(jsonb_build_object('session_id', s.id), 'end', 'jigsaw:session:' || s.id, true);
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function
  jigsaw_private.grid_for(integer, double precision),
  jigsaw_private.random_uint32(),
  jigsaw_private.online_since(),
  jigsaw_private.lock_own_session(bigint),
  jigsaw_private.create_puzzle(bigint, smallint, smallint),
  jigsaw_private.deal_tray(bigint, uuid[], uuid[]),
  jigsaw_private.free_color(bigint, bigint),
  jigsaw_private.delete_orphan_students(uuid[])
  from public, anon, authenticated;

revoke all on function
  jigsaw.create_session(integer, integer, text, uuid, double precision, boolean, boolean, boolean, boolean),
  jigsaw.join_session(text),
  jigsaw.assign_member(bigint, bigint),
  jigsaw.randomize_groups(bigint),
  jigsaw.start_session(bigint),
  jigsaw.end_session(bigint)
  from public, anon;
grant execute on function
  jigsaw.create_session(integer, integer, text, uuid, double precision, boolean, boolean, boolean, boolean),
  jigsaw.join_session(text),
  jigsaw.assign_member(bigint, bigint),
  jigsaw.randomize_groups(bigint),
  jigsaw.start_session(bigint),
  jigsaw.end_session(bigint)
  to authenticated, service_role;

notify pgrst, 'reload schema';
