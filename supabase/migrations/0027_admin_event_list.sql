/*
  Every outing, for a league admin, and a way to delete the dead ones.

  There is deliberately no public list of events anywhere — an event's token is
  its credential, so listing them would hand out access. This is the one
  exception, and it is gated on is_admin(): the league admin created them and
  is the only person who can already reach every one.

  The payload is an allowlist. `admin_pin_hash` and `admin_token` are the
  event-admin credential and are not needed to run this screen, so they do not
  leave the database — the same mistake as migration 0016, not made twice.
*/
create or replace function admin_events()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
begin
  if not is_admin() then
    raise exception 'Admins only.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(payload order by played_on desc, created_at desc)
      from (
        select e.played_on,
               e.created_at,
               jsonb_build_object(
                 'id',          e.id,
                 'name',        e.name,
                 'playedOn',    e.played_on,
                 'format',      e.format,
                 'holeCount',   e.hole_count,
                 'courseName',  e.course_name,
                 -- The share link, which is the point of the screen: an admin
                 -- who needs to re-send an invite has nowhere else to get it.
                 'shareToken',  e.share_token,
                 'completedAt', e.completed_at,
                 'createdAt',   e.created_at,
                 'playerCount', (
                   select count(*) from event_players p
                    where p.event_id = e.id
                 ),
                 'scoreCount', (
                   select count(*) from event_scores s
                    where s.event_id = e.id
                 ),
                 'lastScoreAt', (
                   select max(s.updated_at) from event_scores s
                    where s.event_id = e.id
                 )
               ) as payload
          from events e
      ) as rows
  ), '[]'::jsonb);
end;
$fn$;

revoke execute on function admin_events() from public;
revoke execute on function admin_events() from anon;
grant execute on function admin_events() to authenticated;

/*
  Delete an outing and everything hanging off it.

  Refuses exactly one case: today's outing, not closed out, with cards already
  on it — someone may be part-way round. Anything else goes, including one
  created by mistake this morning, which has no scores and so nothing to lose.
  `canDeleteEvent` in src/lib/event-status.ts applies the same rule in the UI;
  this is the copy that counts, because a POST straight to PostgREST never
  sees the button.

  The cascade takes players, teams, scores and tee times with it, so the audit
  row is written first — it is the only record that will survive.
*/
create or replace function admin_delete_event(in_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target events%rowtype;
  scores bigint;
begin
  if not is_admin() then
    raise exception 'Admins only.' using errcode = 'insufficient_privilege';
  end if;

  select * into target from events where id = in_event_id;

  if not found then
    raise exception 'No such outing.' using errcode = 'no_data_found';
  end if;

  select count(*) into scores
    from event_scores where event_id = in_event_id;

  if target.completed_at is null
     and target.played_on >= current_date
     and scores > 0 then
    raise exception 'Someone may still be playing this. Close it out first.'
      using errcode = 'check_violation';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (
    auth.uid(),
    'delete',
    'event',
    in_event_id::text,
    jsonb_build_object(
      'name', target.name,
      'played_on', target.played_on,
      'score_count', scores,
      'completed_at', target.completed_at
    )
  );

  delete from events where id = in_event_id;
end;
$fn$;

revoke execute on function admin_delete_event(uuid) from public;
revoke execute on function admin_delete_event(uuid) from anon;
grant execute on function admin_delete_event(uuid) to authenticated;
