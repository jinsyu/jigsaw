-- T5: puzzle RPCs (take_from_tray, grab, drop) with the SQL snap check, frame lock and
-- completion. Also the T4 review follow-ups (deal_tray race, join_session account_gone,
-- assign_member comment) and one lock order for assign_member / end_session.
--
-- Snap rules
-- private.resolve_drop() is a pure function that implements public/js/puzzle/snap.js
-- resolveDrop() step by step (clamp -> neighbour merges -> snap into the frame) in float8
-- with the same operation order, and private.held_by_other() is snap.js isHeldByOther().
-- tests/db/snap-parity.test.js runs every case of tests/fixtures/snap-cases.json through
-- both, and through the drop / take_from_tray RPCs, and requires identical results.
-- The tolerance lives in private.snap_tolerance() (= snap.js SNAP_TOLERANCE = fixture
-- defaultTolerance = 40), the hold time in private.held_by_other() (= HOLD_MS = 10 s).
--
-- Holds: a cluster is "held by another student" for the caller when grabbed_by is set, is
-- not the caller, was grabbed less than 10 seconds ago and the holder is connected
-- (members row in that group with last_seen in the last 15 seconds, private.online_since).
-- Such clusters cannot be grabbed and are left out of merges (they stay on the board and
-- count for progress). Locked clusters (in the frame) can never be grabbed.
--
-- Results: rule outcomes never raise. Every RPC returns jsonb
--   { ok: true, ... }  or  { ok: false, reason }
-- with reason one of
--   not_found     cluster/group does not exist, is not on the board, or is not in my group
--   not_playing   the session is waiting or ended
--   bad_position  x or y is null, NaN or +-Infinity
--   not_in_tray   take_from_tray: the piece is not in my tray (taken, dealt away, bad index)
--   held          grab: another student holds it (also returns held_by = their uid)
--   locked        grab/drop: the cluster is fixed in the frame
--   not_held      drop: I am not holding this cluster (never grabbed, or taken over)
-- The screen store maps them 1:1 with reason.replaceAll('_', '-').
-- Raised errors are for callers that should never call these: 42501 forbidden when the
-- caller is not a student (no JWT, or a teacher account).
--
-- take_from_tray(group, piece, x, y)  piece = row * cols + col (store piece index)
--   Puts my tray piece on the board and resolves it exactly like a drop of that one-piece
--   cluster (clamp, merges, frame). It ends up released, not held.
--   -> { ok, cluster_id, piece, id, x, y, z, locked, absorbed, progress, completed_at, completed_now }
-- grab(cluster)
--   -> { ok, cluster_id, z, grabbed_at }
-- drop(cluster, x, y)
--   -> { ok, cluster_id, id, x, y, z, locked, absorbed, progress, completed_at, completed_now }
--   id/x/y/z/locked = the cluster the dropped pieces ended up in (absorbed ids are gone),
--   progress = { placed (locked pieces), total, complete (all locked) }, completed_at =
--   groups.completed_at (set by the drop that locked the last piece, completed_now = true).
--
-- Broadcasts on group:<id> (realtime.send, private). No names, uids only.
--   'take'  the take_from_tray result fields (without ok) + by
--   'grab'  { by, cluster_id, z, grabbed_at }
--   'drop'  the drop result fields (without ok) + by
-- Payloads carry float8 x, y: functions that build them declare extra_float_digits = 1 so
-- the JSON numbers are the shortest exact text (the image default 0 rounds to 15 digits).
--
-- Concurrency
-- - grab is one conditional update: the row lock makes the first caller win and the second
--   re-check sees the new holder (READ COMMITTED re-evaluates the WHERE on the new row).
-- - drop and take_from_tray lock the group row and then every cluster row of the group (in
--   id order) before reading the board, so drops of one group run one after another and a
--   grab that is in flight finishes first (or waits and then sees the merge).
-- - deal_tray (teacher moves, T6 redistribution) only moves pieces that are still in the
--   expected tray, so it cannot give an owner back to a piece a student just took.
-- - Lock order everywhere: session row -> group rows (id order) -> their clusters (id order)
--   -> pieces. assign_member and end_session (below) take the boards with lock_board before
--   they release grabs or delete accounts (grabbed_by is "on delete set null"), so they
--   never hold a cluster that a drop is waiting for while waiting for one the drop holds.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.clusters add column locked boolean not null default false;
comment on column public.clusters.locked is
  'Snapped into the frame (completed picture position): fixed for good, cannot be grabbed.';

-- ---------------------------------------------------------------------------
-- Pure snap rules (shared with public/js/puzzle/snap.js)
-- ---------------------------------------------------------------------------

create function private.snap_tolerance()
returns double precision
language sql immutable set search_path = ''
as $$
  select 40::double precision;
$$;

-- snap.js isHeldByOther(): p_now - p_grabbed_at < 10 s, holder set, not me, holder connected.
create function private.held_by_other(p_holder uuid, p_grabbed_at timestamptz,
                                      p_holder_online boolean, p_me uuid, p_now timestamptz)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(
    p_holder is not null
    and p_holder <> p_me
    and p_now - p_grabbed_at < interval '10 seconds'
    and p_holder_online,
    false);
$$;

-- p_clusters: [{ id, x, y, locked?, held?, pieces: [[col, row], ...] }, ...] (board only).
-- held = held by another student: kept on the board but never a merge candidate.
-- Returns snap.js resolveDrop()'s shape:
-- { id, x, y, locked, absorbed, clusters: [{ id, x, y, locked, pieces }], placed, total, complete }.
create function private.resolve_drop(
  p_cols integer,
  p_rows integer,
  p_aspect double precision,
  p_clusters jsonb,
  p_drop_id bigint,
  p_x double precision,
  p_y double precision,
  p_tol double precision
)
returns jsonb
language plpgsql immutable
set search_path = '' set extra_float_digits = 1
as $$
declare
  total constant integer := p_cols * p_rows;
  -- Same expressions and order as geometry.layoutFor() and snap.frameOrigin().
  width constant double precision := p_cols::double precision * 100;
  height constant double precision := width / p_aspect;
  pw constant double precision := 100;
  ph constant double precision := height / p_rows::double precision;
  board_w constant double precision := width * sqrt(2::double precision);
  board_h constant double precision := height * sqrt(2::double precision);
  frame_x constant double precision := (board_w - width) / 2;
  frame_y constant double precision := (board_h - height) / 2;
  tol2 constant double precision := p_tol * p_tol;
  n constant integer := coalesce(jsonb_array_length(p_clusters), 0);
  ids bigint[] := '{}';
  xs double precision[] := '{}';
  ys double precision[] := '{}';
  locks boolean[] := '{}';
  helds boolean[] := '{}';
  sizes integer[] := '{}';
  -- Cell k = row * cols + col + 1 -> index of the cluster holding it (0 = not on the board).
  owner integer[] := array_fill(0, array[total]);
  pieces_of jsonb[] := '{}';
  c jsonb;
  cell jsonb;
  i integer;
  k integer;
  nk integer;
  col integer;
  r integer;
  d integer;
  cur integer;
  best integer;
  j integer;
  anchor integer;
  other integer;
  dx double precision;
  dy double precision;
  d2 double precision;
  best_d2 double precision;
  min_col integer;
  max_col integer;
  min_row integer;
  max_row integer;
  absorbed bigint[] := '{}';
  placed integer := 0;
  out_clusters jsonb := '[]';
begin
  for i in 1 .. n loop
    c := p_clusters -> (i - 1);
    ids[i] := (c ->> 'id')::bigint;
    xs[i] := (c ->> 'x')::double precision;
    ys[i] := (c ->> 'y')::double precision;
    locks[i] := coalesce((c ->> 'locked')::boolean, false);
    helds[i] := coalesce((c ->> 'held')::boolean, false);
    sizes[i] := 0;
    pieces_of[i] := '[]'::jsonb;
    for cell in select e.value from jsonb_array_elements(c -> 'pieces') e loop
      col := (cell ->> 0)::integer;
      r := (cell ->> 1)::integer;
      if col < 0 or col >= p_cols or r < 0 or r >= p_rows then
        raise exception 'invalid_cell' using errcode = '22023';
      end if;
      k := r * p_cols + col + 1;
      if owner[k] <> 0 then
        raise exception 'duplicate_cell' using errcode = '22023';
      end if;
      owner[k] := i;
      sizes[i] := sizes[i] + 1;
    end loop;
    if sizes[i] = 0 then
      raise exception 'empty_cluster' using errcode = '22023';
    end if;
    if ids[i] = p_drop_id then
      d := i;
    end if;
  end loop;
  if d is null then
    raise exception 'dropped_cluster_not_found' using errcode = '22023';
  end if;
  helds[d] := false;
  -- Locked clusters cannot be grabbed, so they are never dropped (snap.js throws too).
  if locks[d] then
    raise exception 'dropped_cluster_locked' using errcode = '22023';
  end if;

  -- 1. Clamp the dropped cluster's requested position by its piece cells.
  select min((s - 1) % p_cols), max((s - 1) % p_cols), min((s - 1) / p_cols), max((s - 1) / p_cols)
  into min_col, max_col, min_row, max_row
  from generate_subscripts(owner, 1) s
  where owner[s] = d;
  xs[d] := least(greatest(p_x, 0::double precision - min_col::double precision * pw),
                 board_w - (max_col + 1)::double precision * pw);
  ys[d] := least(greatest(p_y, 0::double precision - min_row::double precision * ph),
                 board_h - (max_row + 1)::double precision * ph);

  -- 2-5. Merge the nearest edge-adjacent cluster until none is within the tolerance.
  cur := d;
  loop
    best := 0;
    for k in 1 .. total loop
      continue when owner[k] <> cur;
      col := (k - 1) % p_cols;
      r := (k - 1) / p_cols;
      foreach nk in array array[
        case when col > 0 then k - 1 else 0 end,
        case when col < p_cols - 1 then k + 1 else 0 end,
        case when r > 0 then k - p_cols else 0 end,
        case when r < p_rows - 1 then k + p_cols else 0 end
      ] loop
        continue when nk = 0;
        j := owner[nk];
        continue when j = 0 or j = cur or helds[j];
        dx := xs[j] - xs[cur];
        dy := ys[j] - ys[cur];
        d2 := dx * dx + dy * dy;
        if d2 <= tol2 and (best = 0 or d2 < best_d2 or (d2 = best_d2 and ids[j] < ids[best])) then
          best := j;
          best_d2 := d2;
        end if;
      end loop;
    end loop;
    exit when best = 0;

    if locks[cur] <> locks[best] then
      anchor := case when locks[cur] then cur else best end;
    elsif sizes[cur] > sizes[best] or (sizes[cur] = sizes[best] and ids[cur] < ids[best]) then
      anchor := cur;
    else
      anchor := best;
    end if;
    other := case when anchor = cur then best else cur end;
    for k in 1 .. total loop
      if owner[k] = other then
        owner[k] := anchor;
      end if;
    end loop;
    sizes[anchor] := sizes[anchor] + sizes[other];
    sizes[other] := 0;
    locks[anchor] := locks[anchor] or locks[other];
    absorbed := absorbed || ids[other];
    cur := anchor;
  end loop;

  -- 6. Snap into the frame.
  if not locks[cur] then
    dx := frame_x - xs[cur];
    dy := frame_y - ys[cur];
    if dx * dx + dy * dy <= tol2 then
      xs[cur] := frame_x;
      ys[cur] := frame_y;
      locks[cur] := true;
    end if;
  end if;

  -- Result: clusters by id, pieces by row then col (cell order).
  for k in 1 .. total loop
    i := owner[k];
    continue when i = 0;
    pieces_of[i] := pieces_of[i] || jsonb_build_array(jsonb_build_array((k - 1) % p_cols, (k - 1) / p_cols));
  end loop;
  for i in select s from generate_subscripts(ids, 1) s where sizes[s] > 0 order by ids[s] loop
    out_clusters := out_clusters || jsonb_build_array(jsonb_build_object(
      'id', ids[i], 'x', xs[i], 'y', ys[i], 'locked', locks[i], 'pieces', pieces_of[i]));
    if locks[i] then
      placed := placed + sizes[i];
    end if;
  end loop;

  return jsonb_build_object(
    'id', ids[cur],
    'x', xs[cur],
    'y', ys[cur],
    'locked', locks[cur],
    'absorbed', to_jsonb(absorbed),
    'clusters', out_clusters,
    'placed', placed,
    'total', total,
    'complete', total > 0 and placed = total
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers for the RPCs
-- ---------------------------------------------------------------------------

create function private.require_student()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create function private.refuse(p_reason text, p_extra jsonb default '{}'::jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'reason', p_reason) || p_extra;
$$;

-- NaN compares greater than every number in Postgres, so "< Infinity" also rejects NaN.
create function private.is_finite_point(p_x double precision, p_y double precision)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(
    p_x > '-Infinity'::double precision and p_x < 'Infinity'::double precision
    and p_y > '-Infinity'::double precision and p_y < 'Infinity'::double precision,
    false);
$$;

-- The holder still belongs to the group and sent a signal in the last 15 seconds.
create function private.is_online(p_user uuid, p_group bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.user_id = p_user and m.group_id = p_group and m.last_seen >= private.online_since()
  );
$$;

-- Locks the group row, then every cluster of the group (id order), and returns the session.
create function private.lock_board(p_group bigint)
returns public.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.sessions;
begin
  select se.* into s
  from public.groups gr join public.sessions se on se.id = gr.session_id
  where gr.id = p_group
  for update of gr;
  perform 1 from public.clusters c where c.group_id = p_group order by c.id for update;
  return s;
end;
$$;

-- Resolves a drop of p_cluster at (p_x, p_y) on the locked board and writes the result:
-- absorbed clusters are deleted (their pieces move to the survivor), the survivor gets
-- its position and lock and is released, and the group is marked complete once.
create function private.settle_drop(p_session public.sessions, p_group bigint, p_uid uuid,
                                    p_cluster bigint, p_x double precision, p_y double precision)
returns jsonb
language plpgsql volatile security definer
set search_path = '' set extra_float_digits = 1
as $$
declare
  board jsonb;
  r jsonb;
  survivor public.clusters;
  absorbed bigint[];
  dropped_z integer;
  completed timestamptz;
  completed_now boolean := false;
begin
  select c.z into dropped_z from public.clusters c where c.id = p_cluster;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'x', c.x, 'y', c.y, 'locked', c.locked, 'pieces', pc.cells,
           'held', c.id <> p_cluster and private.held_by_other(
             c.grabbed_by, c.grabbed_at, private.is_online(c.grabbed_by, p_group), p_uid, now()))),
         '[]'::jsonb)
  into board
  from public.clusters c
  cross join lateral (
    select jsonb_agg(jsonb_build_array(p.col, p."row")) as cells
    from public.pieces p
    where p.cluster_id = c.id and p.on_board
  ) pc
  where c.group_id = p_group and pc.cells is not null;

  r := private.resolve_drop(p_session.cols, p_session.rows, p_session.aspect, board,
                            p_cluster, p_x, p_y, private.snap_tolerance());

  absorbed := array(select e::bigint from jsonb_array_elements_text(r -> 'absorbed') e);
  if cardinality(absorbed) > 0 then
    update public.pieces set cluster_id = (r ->> 'id')::bigint where cluster_id = any (absorbed);
    delete from public.clusters where id = any (absorbed);
  end if;

  update public.clusters
  set x = (r ->> 'x')::double precision,
      y = (r ->> 'y')::double precision,
      locked = (r ->> 'locked')::boolean,
      grabbed_by = null,
      grabbed_at = null,
      z = greatest(z, dropped_z)
  where id = (r ->> 'id')::bigint
  returning * into survivor;

  if (r ->> 'complete')::boolean then
    update public.groups set completed_at = now()
    where id = p_group and completed_at is null;
    completed_now := found;
  end if;
  select g.completed_at into completed from public.groups g where g.id = p_group;

  return jsonb_build_object(
    'id', survivor.id,
    'x', survivor.x,
    'y', survivor.y,
    'z', survivor.z,
    'locked', survivor.locked,
    'absorbed', r -> 'absorbed',
    'progress', jsonb_build_object('placed', r -> 'placed', 'total', r -> 'total', 'complete', r -> 'complete'),
    'completed_at', completed,
    'completed_now', completed_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- A student puts one of their tray pieces on the board at (p_x, p_y) (picture origin).
-- It is resolved like a drop of that one-piece cluster and ends up released.
create function public.take_from_tray(p_group bigint, p_piece integer,
                                      p_x double precision, p_y double precision)
returns jsonb
language plpgsql volatile security definer
set search_path = '' set extra_float_digits = 1
as $$
declare
  uid uuid := private.require_student();
  s public.sessions;
  taken bigint;
  result jsonb;
begin
  if not private.is_finite_point(p_x, p_y) then
    return private.refuse('bad_position');
  end if;
  if p_group is null or not private.is_group_member(p_group) then
    return private.refuse('not_found');
  end if;
  s := private.lock_board(p_group);
  if s.status <> 'playing' then
    return private.refuse('not_playing');
  end if;
  if p_piece is null or p_piece < 0 or p_piece >= s.cols * s.rows then
    return private.refuse('not_in_tray');
  end if;

  -- Conditional: a concurrent deal_tray may have given the piece to someone else.
  update public.pieces p
  set on_board = true, owner_id = null
  where p.group_id = p_group
    and p.col = p_piece % s.cols
    and p."row" = p_piece / s.cols
    and p.owner_id = uid
    and not p.on_board
  returning p.cluster_id into taken;
  if not found then
    return private.refuse('not_in_tray');
  end if;

  update public.clusters
  set z = (select coalesce(max(x.z), 0) + 1 from public.clusters x where x.group_id = p_group)
  where id = taken;

  result := jsonb_build_object('cluster_id', taken, 'piece', p_piece)
            || private.settle_drop(s, p_group, uid, taken, p_x, p_y);
  perform realtime.send(result || jsonb_build_object('by', uid), 'take', 'group:' || p_group, true);
  return jsonb_build_object('ok', true) || result;
end;
$$;

-- A student picks up a cluster on the board. One conditional update: the first caller wins.
create function public.grab(p_cluster bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := private.require_student();
  g bigint;
  session_status text;
  grabbed public.clusters;
begin
  select c.group_id into g from public.clusters c where c.id = p_cluster;
  if not found or not private.is_group_member(g) then
    return private.refuse('not_found');
  end if;
  select se.status into session_status
  from public.groups gr join public.sessions se on se.id = gr.session_id
  where gr.id = g;
  if session_status <> 'playing' then
    return private.refuse('not_playing');
  end if;

  update public.clusters c
  set grabbed_by = uid,
      grabbed_at = now(),
      z = (select coalesce(max(x.z), 0) + 1 from public.clusters x where x.group_id = g)
  where c.id = p_cluster
    and not c.locked
    and exists (select 1 from public.pieces p where p.cluster_id = c.id and p.on_board)
    and not private.held_by_other(c.grabbed_by, c.grabbed_at, private.is_online(c.grabbed_by, g),
                                  uid, now())
  returning c.* into grabbed;

  if not found then
    select c.* into grabbed from public.clusters c where c.id = p_cluster;
    if not found or not exists (
      select 1 from public.pieces p where p.cluster_id = p_cluster and p.on_board
    ) then
      return private.refuse('not_found');
    end if;
    if grabbed.locked then
      return private.refuse('locked');
    end if;
    return private.refuse('held', jsonb_build_object('held_by', grabbed.grabbed_by));
  end if;

  perform realtime.send(
    jsonb_build_object('by', uid, 'cluster_id', grabbed.id, 'z', grabbed.z, 'grabbed_at', grabbed.grabbed_at),
    'grab', 'group:' || g, true);
  return jsonb_build_object('ok', true, 'cluster_id', grabbed.id, 'z', grabbed.z,
                            'grabbed_at', grabbed.grabbed_at);
end;
$$;

-- The holder drops a cluster at (p_x, p_y): clamp, merges, frame, completion, broadcast.
create function public.drop(p_cluster bigint, p_x double precision, p_y double precision)
returns jsonb
language plpgsql volatile security definer
set search_path = '' set extra_float_digits = 1
as $$
declare
  uid uuid := private.require_student();
  g bigint;
  s public.sessions;
  dropped public.clusters;
  result jsonb;
begin
  if not private.is_finite_point(p_x, p_y) then
    return private.refuse('bad_position');
  end if;
  select c.group_id into g from public.clusters c where c.id = p_cluster;
  if not found or not private.is_group_member(g) then
    return private.refuse('not_found');
  end if;
  s := private.lock_board(g);
  if s.status <> 'playing' then
    return private.refuse('not_playing');
  end if;

  -- Re-read under the locks: an earlier drop may have absorbed or locked it.
  select c.* into dropped from public.clusters c where c.id = p_cluster;
  if not found or not exists (
    select 1 from public.pieces p where p.cluster_id = p_cluster and p.on_board
  ) then
    return private.refuse('not_found');
  end if;
  if dropped.locked then
    return private.refuse('locked');
  end if;
  if dropped.grabbed_by is distinct from uid then
    return private.refuse('not_held');
  end if;

  result := jsonb_build_object('cluster_id', p_cluster)
            || private.settle_drop(s, g, uid, p_cluster, p_x, p_y);
  perform realtime.send(result || jsonb_build_object('by', uid), 'drop', 'group:' || g, true);
  return jsonb_build_object('ok', true) || result;
end;
$$;

-- ---------------------------------------------------------------------------
-- T4 review follow-ups
-- ---------------------------------------------------------------------------

-- 1. deal_tray: the update re-checks "still in the expected tray and not on the board".
--    Under READ COMMITTED a piece taken by a concurrent take_from_tray is re-read after the
--    taker commits, and the re-check skips it instead of giving it an owner again.
create or replace function private.deal_tray(p_group bigint, p_from uuid[], p_to uuid[])
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

-- 2. join_session: an account deleted by end_session or cleanup can still hold a valid JWT.
--    It now gets { ok: false, error: 'account_gone' } (sign in anonymously again) instead of
--    a raw foreign key error.
create or replace function public.join_session(p_code text)
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

  if not exists (select 1 from auth.users u where u.id = uid) then
    return jsonb_build_object('ok', false, 'error', 'account_gone');
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

-- 3. assign_member: the comment now matches the answers. While playing it also locks the
--    old and new boards (lock_board, group id order) before releasing grabs or dealing.
create or replace function public.assign_member(p_member bigint, p_group bigint)
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
  board bigint;
begin
  select * into m from public.members where id = p_member;
  if not found then
    -- Missing member: member_not_found for a teacher, forbidden for anyone else.
    -- A member of another teacher's session gets forbidden from lock_own_session below.
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

  if s.status = 'playing' then
    -- Same lock order as drop / take_from_tray: group rows, then their clusters.
    for board in
      select gid from unnest(array[old_group, p_group]) gid where gid is not null order by gid
    loop
      perform private.lock_board(board);
    end loop;
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

-- 4. end_session: locks every board of the session (group id order) before deleting the
--    accounts, whose "on delete set null" on clusters.grabbed_by updates cluster rows, and
--    before releasing grabs. Otherwise unchanged.
create or replace function public.end_session(p_session bigint)
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

  for g in select gr.id from public.groups gr where gr.session_id = s.id order by gr.id loop
    perform private.lock_board(g.id);
  end loop;

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
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function
  private.snap_tolerance(),
  private.held_by_other(uuid, timestamptz, boolean, uuid, timestamptz),
  private.resolve_drop(integer, integer, double precision, jsonb, bigint, double precision,
                       double precision, double precision),
  private.require_student(),
  private.refuse(text, jsonb),
  private.is_finite_point(double precision, double precision),
  private.is_online(uuid, bigint),
  private.lock_board(bigint),
  private.settle_drop(public.sessions, bigint, uuid, bigint, double precision, double precision)
  from public, anon, authenticated;

revoke all on function
  public.take_from_tray(bigint, integer, double precision, double precision),
  public.grab(bigint),
  public.drop(bigint, double precision, double precision)
  from public, anon;
grant execute on function
  public.take_from_tray(bigint, integer, double precision, double precision),
  public.grab(bigint),
  public.drop(bigint, double precision, double precision)
  to authenticated, service_role;

notify pgrst, 'reload schema';
