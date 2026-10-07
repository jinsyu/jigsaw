-- Reads with exact float8: the teacher's 모둠 한눈에 보기 (D10, D11) and the board and
-- session reads of the puzzle screens.
--
-- session_overview reads every board of a session in one call.
--
-- The overview polls this every 3 seconds instead of listening to the jigsaw:group:<id> broadcasts
-- (spec: saves Realtime messages). One statement, so every group, cluster and piece comes from
-- the same snapshot.
--
-- session_overview(session)
--   -> { now, status, started_at, ended_at,
--        groups: [{ id, number, completed_at, total, placed,
--                   clusters: [{ id, x, y, locked, held_by, pieces: [index, ...] }] }],
--        members: [{ id, user_id, group_id, color, last_seen }] }
--   now          the server time, so the screen can show the time taken on its own clock.
--   total        pieces of the group's puzzle (0: no puzzle yet, the group had no students
--                at the start), placed = pieces in locked clusters (same as drop's progress).
--   clusters     on the board only (tray pieces are not drawn), locked ones first, then by z:
--                the drawing order. pieces = row * cols + col of each on-board piece.
--   held_by      the holder while the hold still protects the cluster, by the same rule as
--                grab / drop (jigsaw_private.held_by_other: grabbed under 10 s ago and the
--                holder connected), else null.
--   members      no names: names live only in Presence (D14). last_seen tells how long a
--                student who left Presence has been away.
-- Only the session's teacher may call it (42501 forbidden otherwise). Read only, no locks.
-- float8 x / y print exactly (extra_float_digits = 1), like the other float8 JSON.

create function jigsaw.session_overview(p_session bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' set extra_float_digits = 1
as $$
declare
  s jigsaw.sessions;
begin
  if not jigsaw_private.is_session_teacher(p_session) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into s from jigsaw.sessions where id = p_session;

  return jsonb_build_object(
    'now', now(),
    'status', s.status,
    'started_at', s.started_at,
    'ended_at', s.ended_at,
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id,
        'number', g.number,
        'completed_at', g.completed_at,
        'total', (select count(*) from jigsaw.pieces p where p.group_id = g.id),
        'placed', (
          select count(*) from jigsaw.pieces p
          join jigsaw.clusters c on c.id = p.cluster_id
          where p.group_id = g.id and p.on_board and c.locked
        ),
        'clusters', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', c.id,
            'x', c.x,
            'y', c.y,
            'locked', c.locked,
            -- Same rule as grab / drop (jigsaw_private.held_by_other): under 10 s and the holder connected.
            'held_by', case when jigsaw_private.held_by_other(
                c.grabbed_by, c.grabbed_at, jigsaw_private.is_online(c.grabbed_by, g.id),
                '00000000-0000-0000-0000-000000000000'::uuid, now()) then c.grabbed_by end,
            'pieces', cells.list
          ) order by c.locked desc, c.z, c.id)
          from jigsaw.clusters c
          join lateral (
            select jsonb_agg(p."row" * s.cols + p.col order by p."row", p.col) as list
            from jigsaw.pieces p
            where p.cluster_id = c.id and p.on_board
          ) cells on cells.list is not null
          where c.group_id = g.id
        ), '[]'::jsonb)
      ) order by g.number)
      from jigsaw.groups g
      where g.session_id = s.id
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'user_id', m.user_id,
        'group_id', m.group_id,
        'color', m.color,
        'last_seen', m.last_seen
      ) order by m.id)
      from jigsaw.members m
      where m.session_id = s.id
    ), '[]'::jsonb)
  );
end;
$$;

-- load_board(group): the board of one group for the student screen (remote-store.js), in the
-- shape of the former PostgREST embed groups -> clusters -> pieces:
--   { completed_at, clusters: [{ id, x, y, z, locked, grabbed_by, grabbed_at,
--                                pieces: [{ col, row, owner_id, on_board }] }] }
-- One statement, so clusters and pieces come from the same snapshot. security invoker: the
-- table policies decide what the caller may read (null when the group is not readable).
create function jigsaw.load_board(p_group bigint)
returns jsonb
language sql stable security invoker set search_path = '' set extra_float_digits = 1
as $$
  select jsonb_build_object(
    'completed_at', g.completed_at,
    'clusters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'x', c.x,
        'y', c.y,
        'z', c.z,
        'locked', c.locked,
        'grabbed_by', c.grabbed_by,
        'grabbed_at', c.grabbed_at,
        'pieces', coalesce((
          select jsonb_agg(jsonb_build_object(
            'col', p.col, 'row', p."row", 'owner_id', p.owner_id, 'on_board', p.on_board
          ) order by p."row", p.col)
          from jigsaw.pieces p
          where p.cluster_id = c.id
        ), '[]'::jsonb)
      ) order by c.id)
      from jigsaw.clusters c
      where c.group_id = g.id
    ), '[]'::jsonb)
  )
  from jigsaw.groups g
  where g.id = p_group;
$$;

-- session_setup(session): the session row as JSON with the exact picture aspect (grid, seed,
-- picture, help settings) for the puzzle screens. security invoker: the table policy decides
-- (the session's teacher or a student of it); null when not readable. RPCs that return the
-- session row type (create_session, start_session, end_session) are turned into JSON by the
-- Data API outside the function, so their aspect has 15 digits: read it here instead.
create function jigsaw.session_setup(p_session bigint)
returns jsonb
language sql stable security invoker set search_path = '' set extra_float_digits = 1
as $$
  select to_jsonb(s) from jigsaw.sessions s where s.id = p_session;
$$;

revoke all on function jigsaw.session_overview(bigint) from public, anon;
grant execute on function jigsaw.session_overview(bigint) to authenticated, service_role;
revoke all on function jigsaw.load_board(bigint), jigsaw.session_setup(bigint) from public, anon;
grant execute on function jigsaw.load_board(bigint), jigsaw.session_setup(bigint)
  to authenticated, service_role;

notify pgrst, 'reload schema';
