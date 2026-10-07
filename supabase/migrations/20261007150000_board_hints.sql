-- Spec change (before T11): the board is three times the picture area, and the teacher
-- picks four help settings per session (spec puzzle rules 5 and 10).
--
-- 1. Board size: each side sqrt(3) times the picture side (was sqrt(2)). Only
--    private.resolve_drop() knows the board size; it is replaced below with the same body
--    except board_w / board_h (= geometry.js layoutFor(), BOARD_SIDE_RATIO = Math.sqrt(3);
--    sqrt() is correctly rounded on both sides, so the sizes are bit-identical).
--    The size is not stored per session: nothing is deployed yet and only local test
--    sessions exist, so every session (old or new) uses the new board.
-- 2. Help settings: four boolean columns on sessions with the spec defaults (the same as
--    public/js/store/puzzle-store.js DEFAULT_HINTS), set by create_session. Students read
--    them through the existing sessions select policy (their own session only).

-- ---------------------------------------------------------------------------
-- 1. Board size
-- ---------------------------------------------------------------------------

create or replace function private.resolve_drop(
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
-- 2. Help settings (spec rule 10)
-- ---------------------------------------------------------------------------

alter table public.sessions
  -- Show where a dragged piece would snap (snapping itself always works).
  add column hint_preview boolean not null default false,
  -- Piece outlines inside the frame (off: the frame border only).
  add column hint_outline boolean not null default true,
  -- The "completed picture" button on the student screen.
  add column hint_picture_button boolean not null default true,
  -- The completed picture very faint inside the frame.
  add column hint_underlay boolean not null default false;

-- New optional arguments at the end: existing calls (named arguments) keep working and get
-- the defaults. The old signature is dropped so the call is never ambiguous.
drop function public.create_session(integer, integer, text, uuid, double precision);

-- Teacher opens a class: picture (built-in key with its aspect, or one of the teacher's
-- images), piece count, group count and the help settings. Picks a code unused by open
-- sessions and a seed. Same body as in 20261007120000_session_flow.sql plus the hints.
create function public.create_session(
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
        (teacher_id, code, builtin_key, image_id, piece_count, cols, rows, aspect, seed,
         hint_preview, hint_outline, hint_picture_button, hint_underlay)
      values (
        auth.uid(),
        lpad((private.random_uint32() % 1000000)::text, 6, '0'),
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

  insert into public.groups (session_id, number)
  select s.id, n from generate_series(1, p_group_count) n;
  return s;
end;
$$;

revoke all on function
  public.create_session(integer, integer, text, uuid, double precision, boolean, boolean, boolean, boolean)
  from public, anon;
grant execute on function
  public.create_session(integer, integer, text, uuid, double precision, boolean, boolean, boolean, boolean)
  to authenticated, service_role;

notify pgrst, 'reload schema';
