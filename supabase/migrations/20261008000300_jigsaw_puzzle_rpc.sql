-- Puzzle RPCs (take_from_tray, grab, drop) with the SQL snap check, frame lock and
-- completion.
--
-- Snap rules
-- jigsaw_private.resolve_drop() is a pure function that implements public/js/puzzle/snap.js
-- resolveDrop() step by step (clamp -> neighbour merges -> snap into the frame) in float8
-- with the same operation order, and jigsaw_private.held_by_other() is snap.js isHeldByOther().
-- tests/db/snap-parity.test.js runs every case of tests/fixtures/snap-cases.json through
-- both, and through the drop / take_from_tray RPCs, and requires identical results.
-- The tolerance lives in jigsaw_private.snap_tolerance() (= snap.js SNAP_TOLERANCE = fixture
-- defaultTolerance = 40), the hold time in jigsaw_private.held_by_other() (= HOLD_MS = 10 s).
--
-- Holds: a cluster is "held by another student" for the caller when grabbed_by is set, is
-- not the caller, was grabbed less than 10 seconds ago and the holder is connected
-- (members row in that group with last_seen in the last 15 seconds, jigsaw_private.online_since).
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
-- Broadcasts on jigsaw:group:<id> (realtime.send, private). No names, uids only.
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
--   -> pieces. assign_member and end_session (jigsaw_session_flow) take the boards with lock_board before
--   they release grabs or delete accounts (grabbed_by is "on delete set null"), so they
--   never hold a cluster that a drop is waiting for while waiting for one the drop holds.

-- ---------------------------------------------------------------------------
-- Pure snap rules (shared with public/js/puzzle/snap.js)
-- ---------------------------------------------------------------------------

create function jigsaw_private.snap_tolerance()
returns double precision
language sql immutable set search_path = ''
as $$
  select 40::double precision;
$$;

-- snap.js isHeldByOther(): p_now - p_grabbed_at < 10 s, holder set, not me, holder connected.
create function jigsaw_private.held_by_other(p_holder uuid, p_grabbed_at timestamptz,
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
-- The board is three times the picture area: each side sqrt(3) times the picture side
-- (= geometry.js layoutFor(), BOARD_SIDE_RATIO = Math.sqrt(3); sqrt() is correctly rounded
-- on both sides, so the sizes are bit-identical).
create function jigsaw_private.resolve_drop(
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
  board_w constant double precision := width * sqrt(3::double precision);
  board_h constant double precision := height * sqrt(3::double precision);
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

create function jigsaw_private.require_student()
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

create function jigsaw_private.refuse(p_reason text, p_extra jsonb default '{}'::jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'reason', p_reason) || p_extra;
$$;

-- NaN compares greater than every number in Postgres, so "< Infinity" also rejects NaN.
create function jigsaw_private.is_finite_point(p_x double precision, p_y double precision)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(
    p_x > '-Infinity'::double precision and p_x < 'Infinity'::double precision
    and p_y > '-Infinity'::double precision and p_y < 'Infinity'::double precision,
    false);
$$;

-- The holder still belongs to the group and sent a signal in the last 15 seconds.
create function jigsaw_private.is_online(p_user uuid, p_group bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from jigsaw.members m
    where m.user_id = p_user and m.group_id = p_group and m.last_seen >= jigsaw_private.online_since()
  );
$$;

-- Locks the group row, then every cluster of the group (id order), and returns the session.
-- The session row is read in a separate statement after the locks are granted, so it sees
-- every commit made before (a drop, take_from_tray or redistribute_stale that waited for
-- end_session sees 'ended' and answers not_playing). Under READ COMMITTED a statement that
-- waited for the group row would not re-read a joined session row that was not changed.
-- The session row itself is not locked.
create function jigsaw_private.lock_board(p_group bigint)
returns jigsaw.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jigsaw.sessions;
begin
  perform 1 from jigsaw.groups gr where gr.id = p_group for update;
  perform 1 from jigsaw.clusters c where c.group_id = p_group order by c.id for update;
  select se.* into s
  from jigsaw.groups gr join jigsaw.sessions se on se.id = gr.session_id
  where gr.id = p_group;
  return s;
end;
$$;

-- Resolves a drop of p_cluster at (p_x, p_y) on the locked board and writes the result:
-- absorbed clusters are deleted (their pieces move to the survivor), the survivor gets
-- its position and lock and is released, and the group is marked complete once.
create function jigsaw_private.settle_drop(p_session jigsaw.sessions, p_group bigint, p_uid uuid,
                                    p_cluster bigint, p_x double precision, p_y double precision)
returns jsonb
language plpgsql volatile security definer
set search_path = '' set extra_float_digits = 1
as $$
declare
  board jsonb;
  r jsonb;
  survivor jigsaw.clusters;
  absorbed bigint[];
  dropped_z integer;
  completed timestamptz;
  completed_now boolean := false;
begin
  select c.z into dropped_z from jigsaw.clusters c where c.id = p_cluster;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'x', c.x, 'y', c.y, 'locked', c.locked, 'pieces', pc.cells,
           'held', c.id <> p_cluster and jigsaw_private.held_by_other(
             c.grabbed_by, c.grabbed_at, jigsaw_private.is_online(c.grabbed_by, p_group), p_uid, now()))),
         '[]'::jsonb)
  into board
  from jigsaw.clusters c
  cross join lateral (
    select jsonb_agg(jsonb_build_array(p.col, p."row")) as cells
    from jigsaw.pieces p
    where p.cluster_id = c.id and p.on_board
  ) pc
  where c.group_id = p_group and pc.cells is not null;

  r := jigsaw_private.resolve_drop(p_session.cols, p_session.rows, p_session.aspect, board,
                            p_cluster, p_x, p_y, jigsaw_private.snap_tolerance());

  absorbed := array(select e::bigint from jsonb_array_elements_text(r -> 'absorbed') e);
  if cardinality(absorbed) > 0 then
    update jigsaw.pieces set cluster_id = (r ->> 'id')::bigint where cluster_id = any (absorbed);
    delete from jigsaw.clusters where id = any (absorbed);
  end if;

  update jigsaw.clusters
  set x = (r ->> 'x')::double precision,
      y = (r ->> 'y')::double precision,
      locked = (r ->> 'locked')::boolean,
      grabbed_by = null,
      grabbed_at = null,
      z = greatest(z, dropped_z)
  where id = (r ->> 'id')::bigint
  returning * into survivor;

  if (r ->> 'complete')::boolean then
    update jigsaw.groups set completed_at = now()
    where id = p_group and completed_at is null;
    completed_now := found;
  end if;
  select g.completed_at into completed from jigsaw.groups g where g.id = p_group;

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
create function jigsaw.take_from_tray(p_group bigint, p_piece integer,
                                      p_x double precision, p_y double precision)
returns jsonb
language plpgsql volatile security definer
set search_path = '' set extra_float_digits = 1
as $$
declare
  uid uuid := jigsaw_private.require_student();
  s jigsaw.sessions;
  taken bigint;
  result jsonb;
begin
  if not jigsaw_private.is_finite_point(p_x, p_y) then
    return jigsaw_private.refuse('bad_position');
  end if;
  if p_group is null or not jigsaw_private.is_group_member(p_group) then
    return jigsaw_private.refuse('not_found');
  end if;
  s := jigsaw_private.lock_board(p_group);
  if s.status <> 'playing' then
    return jigsaw_private.refuse('not_playing');
  end if;
  if p_piece is null or p_piece < 0 or p_piece >= s.cols * s.rows then
    return jigsaw_private.refuse('not_in_tray');
  end if;

  -- Conditional: a concurrent deal_tray may have given the piece to someone else.
  update jigsaw.pieces p
  set on_board = true, owner_id = null
  where p.group_id = p_group
    and p.col = p_piece % s.cols
    and p."row" = p_piece / s.cols
    and p.owner_id = uid
    and not p.on_board
  returning p.cluster_id into taken;
  if not found then
    return jigsaw_private.refuse('not_in_tray');
  end if;

  update jigsaw.clusters
  set z = (select coalesce(max(x.z), 0) + 1 from jigsaw.clusters x where x.group_id = p_group)
  where id = taken;

  result := jsonb_build_object('cluster_id', taken, 'piece', p_piece)
            || jigsaw_private.settle_drop(s, p_group, uid, taken, p_x, p_y);
  perform realtime.send(result || jsonb_build_object('by', uid), 'take', 'jigsaw:group:' || p_group, true);
  return jsonb_build_object('ok', true) || result;
end;
$$;

-- A student picks up a cluster on the board. One conditional update: the first caller wins.
create function jigsaw.grab(p_cluster bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := jigsaw_private.require_student();
  g bigint;
  session_status text;
  grabbed jigsaw.clusters;
begin
  select c.group_id into g from jigsaw.clusters c where c.id = p_cluster;
  if not found or not jigsaw_private.is_group_member(g) then
    return jigsaw_private.refuse('not_found');
  end if;
  select se.status into session_status
  from jigsaw.groups gr join jigsaw.sessions se on se.id = gr.session_id
  where gr.id = g;
  if session_status <> 'playing' then
    return jigsaw_private.refuse('not_playing');
  end if;

  update jigsaw.clusters c
  set grabbed_by = uid,
      grabbed_at = now(),
      z = (select coalesce(max(x.z), 0) + 1 from jigsaw.clusters x where x.group_id = g)
  where c.id = p_cluster
    and not c.locked
    and exists (select 1 from jigsaw.pieces p where p.cluster_id = c.id and p.on_board)
    and not jigsaw_private.held_by_other(c.grabbed_by, c.grabbed_at, jigsaw_private.is_online(c.grabbed_by, g),
                                  uid, now())
  returning c.* into grabbed;

  if not found then
    select c.* into grabbed from jigsaw.clusters c where c.id = p_cluster;
    if not found or not exists (
      select 1 from jigsaw.pieces p where p.cluster_id = p_cluster and p.on_board
    ) then
      return jigsaw_private.refuse('not_found');
    end if;
    if grabbed.locked then
      return jigsaw_private.refuse('locked');
    end if;
    return jigsaw_private.refuse('held', jsonb_build_object('held_by', grabbed.grabbed_by));
  end if;

  perform realtime.send(
    jsonb_build_object('by', uid, 'cluster_id', grabbed.id, 'z', grabbed.z, 'grabbed_at', grabbed.grabbed_at),
    'grab', 'jigsaw:group:' || g, true);
  return jsonb_build_object('ok', true, 'cluster_id', grabbed.id, 'z', grabbed.z,
                            'grabbed_at', grabbed.grabbed_at);
end;
$$;

-- The holder drops a cluster at (p_x, p_y): clamp, merges, frame, completion, broadcast.
create function jigsaw.drop(p_cluster bigint, p_x double precision, p_y double precision)
returns jsonb
language plpgsql volatile security definer
set search_path = '' set extra_float_digits = 1
as $$
declare
  uid uuid := jigsaw_private.require_student();
  g bigint;
  s jigsaw.sessions;
  dropped jigsaw.clusters;
  result jsonb;
begin
  if not jigsaw_private.is_finite_point(p_x, p_y) then
    return jigsaw_private.refuse('bad_position');
  end if;
  select c.group_id into g from jigsaw.clusters c where c.id = p_cluster;
  if not found or not jigsaw_private.is_group_member(g) then
    return jigsaw_private.refuse('not_found');
  end if;
  s := jigsaw_private.lock_board(g);
  if s.status <> 'playing' then
    return jigsaw_private.refuse('not_playing');
  end if;

  -- Re-read under the locks: an earlier drop may have absorbed or locked it.
  select c.* into dropped from jigsaw.clusters c where c.id = p_cluster;
  if not found or not exists (
    select 1 from jigsaw.pieces p where p.cluster_id = p_cluster and p.on_board
  ) then
    return jigsaw_private.refuse('not_found');
  end if;
  if dropped.locked then
    return jigsaw_private.refuse('locked');
  end if;
  if dropped.grabbed_by is distinct from uid then
    return jigsaw_private.refuse('not_held');
  end if;

  result := jsonb_build_object('cluster_id', p_cluster)
            || jigsaw_private.settle_drop(s, g, uid, p_cluster, p_x, p_y);
  perform realtime.send(result || jsonb_build_object('by', uid), 'drop', 'jigsaw:group:' || g, true);
  return jsonb_build_object('ok', true) || result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function
  jigsaw_private.snap_tolerance(),
  jigsaw_private.held_by_other(uuid, timestamptz, boolean, uuid, timestamptz),
  jigsaw_private.resolve_drop(integer, integer, double precision, jsonb, bigint, double precision,
                       double precision, double precision),
  jigsaw_private.require_student(),
  jigsaw_private.refuse(text, jsonb),
  jigsaw_private.is_finite_point(double precision, double precision),
  jigsaw_private.is_online(uuid, bigint),
  jigsaw_private.lock_board(bigint),
  jigsaw_private.settle_drop(jigsaw.sessions, bigint, uuid, bigint, double precision, double precision)
  from public, anon, authenticated;

revoke all on function
  jigsaw.take_from_tray(bigint, integer, double precision, double precision),
  jigsaw.grab(bigint),
  jigsaw.drop(bigint, double precision, double precision)
  from public, anon;
grant execute on function
  jigsaw.take_from_tray(bigint, integer, double precision, double precision),
  jigsaw.grab(bigint),
  jigsaw.drop(bigint, double precision, double precision)
  to authenticated, service_role;

notify pgrst, 'reload schema';
