-- T6: disconnect handling (D8, D9) — heartbeat, holds that lapse on their own, and
-- redistribution of the trays of students gone for over a minute. Also fixes
-- private.lock_board (T5) to read the session status after its locks (see below).
--
-- Connection states, from members.last_seen (the student screen calls heartbeat every 5 s):
--   connected   last signal at most 15 s ago (private.online_since)
--               - only a connected holder protects a grabbed cluster (private.held_by_other)
--               - only connected students receive redistributed pieces
--   away        15 s .. 1 min: holds no longer protect, the tray is kept
--   gone        over 1 min (private.stale_since): the tray is dealt to connected students
-- Coming back (heartbeat, or join_session again with the same account) makes the student
-- connected again; within the minute nothing has been taken from the tray.
--
-- Automatic release (D8): nothing clears grabbed_by on a timer. grab and drop already treat
-- a hold as released once private.held_by_other() is false — grabbed 10 s ago or more, or the
-- holder not connected — so a lapsed hold can be taken by anyone (T5). Before heartbeat,
-- last_seen only changed in join_session, so 15 s after joining every student counted as
-- disconnected and holds protected nothing. heartbeat keeps last_seen fresh.
--
-- heartbeat()
--   -> { ok: true, last_seen } | { ok: false, reason: 'not_found' } (in no open session:
--      never joined, or the session ended and the members row is gone)
--   No broadcast: who is online is shown with Presence on session:<id>.
-- redistribute_stale(group)
--   Deals the tray pieces of gone students of the group to its connected students (including
--   students assigned after the start, who have no tray) with private.deal_tray (shuffled,
--   round-robin, fewest tray pieces first, so the dealt counts differ by at most one). With no
--   connected student nothing moves. Owners of tray pieces that are no longer members of the
--   group count as gone too (assign_member normally deals those right away).
--   Idempotent: once dealt, gone students own no tray pieces, so later or concurrent calls
--   (every screen of the group calls it periodically) find nothing and return no pieces.
--   -> { ok: true, pieces: [{ col, row, owner }] } (empty when nothing moved)
--    | { ok: false, reason: 'not_found' | 'not_playing' }
--   Broadcast on group:<id> when pieces moved: 'tray' { pieces: [{ col, row, owner }] }, the
--   same event as assign_member (T4). Cells and uids only: no names, no float8.
-- Both raise 42501 forbidden for callers that are not students (teacher, no JWT).
--
-- Lock order (same as T5): session row -> group row -> clusters (id order) -> members ->
-- pieces. redistribute_stale takes lock_board(group) first, then the members rows of gone
-- students, then pieces (deal_tray). heartbeat locks only the caller's own members rows, so
-- it can wait behind assign_member / end_session / redistribute_stale but never holds a lock
-- they wait for while waiting itself.
-- Locking the gone students' members rows makes the one-minute decision atomic: a heartbeat
-- that commits first is re-checked (READ COMMITTED re-evaluates the WHERE on the new row) and
-- the student keeps the tray; a heartbeat that arrives during the deal waits and lands after.

-- lock_board fix (T5 follow-up): the session row is read again after the locks are taken.
-- The T5 version returned the session from the same statement that waited for the group row,
-- so the row came from the snapshot taken before the wait (end_session only locks the group
-- row and does not change it, so READ COMMITTED does not re-read the joined session row). A
-- drop, take_from_tray or redistribute_stale that waited for end_session therefore still saw
-- 'playing' and was refused with not_held / not_in_tray instead of not_playing. The separate
-- statement below sees every commit made before the locks were granted, so all of them now
-- answer not_playing. Lock order is unchanged (group row, then clusters in id order); the
-- session row is read without a lock, as before.
create or replace function private.lock_board(p_group bigint)
returns public.sessions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.sessions;
begin
  perform 1 from public.groups gr where gr.id = p_group for update;
  perform 1 from public.clusters c where c.group_id = p_group order by c.id for update;
  select se.* into s
  from public.groups gr join public.sessions se on se.id = gr.session_id
  where gr.id = p_group;
  return s;
end;
$$;

-- A student is gone (tray redistributed) when the last signal is over a minute old.
create function private.stale_since()
returns timestamptz
language sql stable set search_path = ''
as $$
  select now() - interval '1 minute';
$$;

create function public.heartbeat()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := private.require_student();
begin
  update public.members set last_seen = now() where user_id = uid;
  if not found then
    return private.refuse('not_found');
  end if;
  return jsonb_build_object('ok', true, 'last_seen', now());
end;
$$;

create function public.redistribute_stale(p_group bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s public.sessions;
  gone uuid[];
  receivers uuid[];
  dealt jsonb;
begin
  perform private.require_student();
  if p_group is null or not private.is_group_member(p_group) then
    return private.refuse('not_found');
  end if;
  -- lock_board (fixed above) reads the session after the wait, so an end_session that
  -- committed meanwhile is seen as ended.
  s := private.lock_board(p_group);
  if s.status is distinct from 'playing' then
    return private.refuse('not_playing');
  end if;

  perform 1 from public.members m
  where m.group_id = p_group and m.last_seen < private.stale_since()
  order by m.id
  for update;

  select array_agg(distinct p.owner_id) into gone
  from public.pieces p
  where p.group_id = p_group
    and not p.on_board
    and p.owner_id is not null
    and not exists (
      select 1 from public.members m
      where m.group_id = p_group and m.user_id = p.owner_id and m.last_seen >= private.stale_since()
    );

  select array_agg(m.user_id order by m.id) into receivers
  from public.members m
  where m.group_id = p_group and m.last_seen >= private.online_since();

  if gone is null or receivers is null then
    return jsonb_build_object('ok', true, 'pieces', '[]'::jsonb);
  end if;

  dealt := private.deal_tray(p_group, gone, receivers);
  if dealt <> '[]'::jsonb then
    perform realtime.send(jsonb_build_object('pieces', dealt), 'tray', 'group:' || p_group, true);
  end if;
  return jsonb_build_object('ok', true, 'pieces', dealt);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function private.stale_since() from public, anon, authenticated;

revoke all on function
  public.heartbeat(),
  public.redistribute_stale(bigint)
  from public, anon;
grant execute on function
  public.heartbeat(),
  public.redistribute_stale(bigint)
  to authenticated, service_role;

notify pgrst, 'reload schema';
