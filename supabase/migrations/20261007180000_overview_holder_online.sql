-- T12 follow-up: session_overview shows a hold only while it still protects the cluster on the
-- server, by the same rule as grab and drop (private.held_by_other): grabbed under 10 s ago
-- and the holder connected (private.is_online: in the group, a signal in the last 15 s).
-- Before, a holder whose device went away kept the coloured outline on the teacher's boards
-- for up to 10 s although friends could already take the cluster. Otherwise unchanged.

create or replace function public.session_overview(p_session bigint)
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
            -- Same rule as grab / drop (private.held_by_other): under 10 s and the holder connected.
            'held_by', case when private.held_by_other(
                c.grabbed_by, c.grabbed_at, private.is_online(c.grabbed_by, g.id),
                '00000000-0000-0000-0000-000000000000'::uuid, now()) then c.grabbed_by end,
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

notify pgrst, 'reload schema';
