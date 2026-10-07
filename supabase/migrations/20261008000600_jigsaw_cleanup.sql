-- Automatic cleanup (pg_cron job jigsaw-cleanup, hourly).
--
-- 1. Sessions still open 24 hours after creation are ended (the teacher never pressed
--    'end'), so their code is freed and the 30-day deletion below applies.
-- 2. members older than 24 hours (by joined_at) are deleted, and the members of the
--    sessions ended in step 1.
-- 3. jigsaw student accounts older than 24 hours that are in no class are deleted: the
--    anonymous accounts of the members deleted in step 2, and the anonymous accounts in
--    jigsaw_private.student_accounts (every account that called join_session, including
--    failed joins). Other users of the shared gyosil project — teachers, other services'
--    anonymous or signed-in users — are never candidates. An older device account that
--    joined a class in the last 24 hours keeps its members row and is kept.
-- 4. Sessions ended more than 30 days ago are deleted (groups, clusters, pieces cascade).
-- 5. join_failures older than one hour are deleted.
-- Teachers' images are kept until the teacher deletes them (removing a file needs the
-- Storage API, and pictures are not cleaned up automatically).
create function jigsaw_private.cleanup_expired()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  ended_sessions integer;
  deleted_members integer;
  deleted_students integer;
  deleted_sessions integer;
  expired_ids bigint[];
  gone_users uuid[];
begin
  with expired as (
    update jigsaw.sessions set status = 'ended', ended_at = now()
    where status <> 'ended' and created_at < now() - interval '24 hours'
    returning id
  )
  select array_agg(id) into expired_ids from expired;
  ended_sessions := coalesce(cardinality(expired_ids), 0);

  with gone as (
    delete from jigsaw.members
    where joined_at < now() - interval '24 hours' or session_id = any (coalesce(expired_ids, '{}'))
    returning user_id
  )
  select count(*), array_agg(distinct user_id) into deleted_members, gone_users from gone;

  deleted_students := jigsaw_private.delete_orphan_students(array(
    select u.id from auth.users u
    where u.is_anonymous
      and u.created_at < now() - interval '24 hours'
      and (
        u.id = any (coalesce(gone_users, '{}'))
        or exists (select 1 from jigsaw_private.student_accounts a where a.user_id = u.id)
      )
  ));

  delete from jigsaw.sessions
  where status = 'ended' and ended_at < now() - interval '30 days';
  get diagnostics deleted_sessions = row_count;

  delete from jigsaw_private.join_failures where failed_at < now() - interval '1 hour';

  return jsonb_build_object(
    'ended_sessions', ended_sessions,
    'deleted_members', deleted_members,
    'deleted_students', deleted_students,
    'deleted_sessions', deleted_sessions
  );
end;
$$;

revoke all on function jigsaw_private.cleanup_expired() from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('jigsaw-cleanup', '17 * * * *', 'select jigsaw_private.cleanup_expired()');
