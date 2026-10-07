-- Disconnect handling (D8, D9) — heartbeat, holds that lapse on their own, and
-- redistribution of the trays of students gone for over a minute.
--
-- Connection states, from members.last_seen (the student screen calls heartbeat every 5 s):
--   connected   last signal at most 15 s ago (jigsaw_private.online_since)
--               - only a connected holder protects a grabbed cluster (jigsaw_private.held_by_other)
--               - only connected students receive redistributed pieces
--   away        15 s .. 1 min: holds no longer protect, the tray is kept
--   gone        over 1 min (jigsaw_private.stale_since): the tray is dealt to connected students
-- Coming back (heartbeat, or join_session again with the same account) makes the student
-- connected again; within the minute nothing has been taken from the tray.
--
-- Automatic release (D8): nothing clears grabbed_by on a timer. grab and drop already treat
-- a hold as released once jigsaw_private.held_by_other() is false — grabbed 10 s ago or more, or the
-- holder not connected — so a lapsed hold can be taken by anyone (T5). Before heartbeat,
-- last_seen only changed in join_session, so 15 s after joining every student counted as
-- disconnected and holds protected nothing. heartbeat keeps last_seen fresh.
--
-- heartbeat()
--   -> { ok: true, last_seen } | { ok: false, reason: 'not_found' } (in no open session:
--      never joined, or the session ended and the members row is gone)
--   No broadcast: who is online is shown with Presence on jigsaw:session:<id>.
-- redistribute_stale(group)
--   Deals the tray pieces of gone students of the group to its connected students (including
--   students assigned after the start, who have no tray) with jigsaw_private.deal_tray (shuffled,
--   round-robin, fewest tray pieces first, so the dealt counts differ by at most one). With no
--   connected student nothing moves. Owners of tray pieces that are no longer members of the
--   group count as gone too (assign_member normally deals those right away).
--   Idempotent: once dealt, gone students own no tray pieces, so later or concurrent calls
--   (every screen of the group calls it periodically) find nothing and return no pieces.
--   -> { ok: true, pieces: [{ col, row, owner }] } (empty when nothing moved)
--    | { ok: false, reason: 'not_found' | 'not_playing' }
--   Broadcast on jigsaw:group:<id> when pieces moved: 'tray' { pieces: [{ col, row, owner }] }, the
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

-- A student is gone (tray redistributed) when the last signal is over a minute old.
create function jigsaw_private.stale_since()
returns timestamptz
language sql stable set search_path = ''
as $$
  select now() - interval '1 minute';
$$;

create function jigsaw.heartbeat()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := jigsaw_private.require_student();
begin
  update jigsaw.members set last_seen = now() where user_id = uid;
  if not found then
    return jigsaw_private.refuse('not_found');
  end if;
  return jsonb_build_object('ok', true, 'last_seen', now());
end;
$$;

create function jigsaw.redistribute_stale(p_group bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jigsaw.sessions;
  gone uuid[];
  receivers uuid[];
  dealt jsonb;
begin
  perform jigsaw_private.require_student();
  if p_group is null or not jigsaw_private.is_group_member(p_group) then
    return jigsaw_private.refuse('not_found');
  end if;
  -- lock_board reads the session after the wait, so an end_session that
  -- committed meanwhile is seen as ended.
  s := jigsaw_private.lock_board(p_group);
  if s.status is distinct from 'playing' then
    return jigsaw_private.refuse('not_playing');
  end if;

  perform 1 from jigsaw.members m
  where m.group_id = p_group and m.last_seen < jigsaw_private.stale_since()
  order by m.id
  for update;

  select array_agg(distinct p.owner_id) into gone
  from jigsaw.pieces p
  where p.group_id = p_group
    and not p.on_board
    and p.owner_id is not null
    and not exists (
      select 1 from jigsaw.members m
      where m.group_id = p_group and m.user_id = p.owner_id and m.last_seen >= jigsaw_private.stale_since()
    );

  select array_agg(m.user_id order by m.id) into receivers
  from jigsaw.members m
  where m.group_id = p_group and m.last_seen >= jigsaw_private.online_since();

  if gone is null or receivers is null then
    return jsonb_build_object('ok', true, 'pieces', '[]'::jsonb);
  end if;

  dealt := jigsaw_private.deal_tray(p_group, gone, receivers);
  if dealt <> '[]'::jsonb then
    perform realtime.send(jsonb_build_object('pieces', dealt), 'tray', 'jigsaw:group:' || p_group, true);
  end if;
  return jsonb_build_object('ok', true, 'pieces', dealt);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function jigsaw_private.stale_since() from public, anon, authenticated;

revoke all on function
  jigsaw.heartbeat(),
  jigsaw.redistribute_stale(bigint)
  from public, anon;
grant execute on function
  jigsaw.heartbeat(),
  jigsaw.redistribute_stale(bigint)
  to authenticated, service_role;

notify pgrst, 'reload schema';
