-- T12: the teacher's 모둠 한눈에 보기 (D10, D11) reads every board of a session in one call.
--
-- The overview polls this every 3 seconds instead of listening to the group:<id> broadcasts
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
--   held_by      the holder while the hold still protects the cluster (under 10 s), else null.
--   members      no names: names live only in Presence (D14). last_seen tells how long a
--                student who left Presence has been away.
-- Only the session's teacher may call it (42501 forbidden otherwise). Read only, no locks.
-- float8 x / y print exactly (extra_float_digits = 1), like the other float8 JSON.

create function public.session_overview(p_session bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' set extra_float_digits = 1
as $$
declare
  s public.sessions;
begin
  if not private.is_session_teacher(p_session) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into s from public.sessions where id = p_session;

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
        'total', (select count(*) from public.pieces p where p.group_id = g.id),
        'placed', (
          select count(*) from public.pieces p
          join public.clusters c on c.id = p.cluster_id
          where p.group_id = g.id and p.on_board and c.locked
        ),
        'clusters', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', c.id,
            'x', c.x,
            'y', c.y,
            'locked', c.locked,
            'held_by', case when c.grabbed_at > now() - interval '10 seconds' then c.grabbed_by end,
            'pieces', cells.list
          ) order by c.locked desc, c.z, c.id)
          from public.clusters c
          join lateral (
            select jsonb_agg(p."row" * s.cols + p.col order by p."row", p.col) as list
            from public.pieces p
            where p.cluster_id = c.id and p.on_board
          ) cells on cells.list is not null
          where c.group_id = g.id
        ), '[]'::jsonb)
      ) order by g.number)
      from public.groups g
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
      from public.members m
      where m.session_id = s.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.session_overview(bigint) from public, anon;
grant execute on function public.session_overview(bigint) to authenticated, service_role;

notify pgrst, 'reload schema';
