/*
  The demo outing the home page's "One-off outing" panel opens, and a guard
  so it can't be deleted again.

  The first one was deleted from the All outings list along with the dead
  events around it, and the panel's link went dead with it. This recreates it
  on the SAME share token, so the hardcoded link in src/lib/sample-event.ts
  works again without a code change, and so do any old links to it.

  The guard is a trigger rather than a check in admin_delete_event: an admin
  can also delete rows through the table itself (the admin_events policy is
  FOR ALL), so a check that lived only in the function would not cover every
  path. To remove the demo on purpose, clear is_demo first, then delete it.
*/

alter table events
  add column if not exists is_demo boolean not null default false;

create or replace function refuse_demo_delete()
returns trigger
language plpgsql
as $fn$
begin
  -- Depth 1 is a DELETE somebody ran, directly or through a function. Deeper
  -- means a cascade from deleting the profile that owns the demo, which must
  -- not be blocked by an outing nobody is playing.
  if old.is_demo and pg_trigger_depth() = 1 then
    raise exception 'This is the home page''s demo outing, so it can''t be deleted.'
      using errcode = 'check_violation';
  end if;

  return old;
end;
$fn$;

drop trigger if exists events_keep_demo on events;
create trigger events_keep_demo
  before delete on events
  for each row execute function refuse_demo_delete();

/*
  admin_events, as in 0027, plus isDemo so the list can label the demo and
  leave its Delete button off. Still an allowlist: no admin_pin_hash, no
  admin_token.
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
                 'shareToken',  e.share_token,
                 'completedAt', e.completed_at,
                 'createdAt',   e.created_at,
                 'isDemo',      e.is_demo,
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
  The demo itself: 2-man best ball at Forest Akers East, eight players in four
  teams, two teams to each of two tee times. Built the way create_event builds
  one, minus the admin PIN — with no hash the event admin page refuses
  everyone, which is right for a page any visitor can open.

  Idempotent: if an outing already holds the token, it is left alone.
*/
do $seed$
declare
  token    constant text := '4af454d0b54143ed9fa73551f56b30a6';
  names    constant text[] := array[
    'Alex', 'Blake', 'Casey', 'Drew', 'Emerson', 'Finley', 'Harper', 'Jordan'
  ];
  owner    uuid;
  c_id     uuid;
  c_name   text;
  c_place  text;
  c_lat    double precision;
  c_lon    double precision;
  demo     uuid;
  players  uuid[] := '{}';
  teams    uuid[] := '{}';
  new_id   uuid;
  n        int;
begin
  if exists (select 1 from events where share_token = token) then
    raise notice 'An outing already uses the demo token; leaving it alone.';
    return;
  end if;

  select id into owner
    from profiles where is_admin order by created_at limit 1;

  if owner is null then
    raise exception 'No admin profile to own the demo outing.';
  end if;

  select id, name, location_name, latitude, longitude
    into c_id, c_name, c_place, c_lat, c_lon
    from courses where name = 'Forest Akers East'
   limit 1;

  insert into events (
    share_token, name, played_on, format, hole_count,
    course_id, course_name, location_name, latitude, longitude,
    created_by, is_demo
  )
  values (
    token, 'Demo Outing', current_date, 'best_ball_2', 18,
    c_id, coalesce(c_name, 'Forest Akers East'), c_place, c_lat, c_lon,
    owner, true
  )
  returning id into demo;

  for n in 1 .. array_length(names, 1) loop
    insert into event_players (event_id, name, position)
    values (demo, names[n], n - 1)
    returning id into new_id;

    players := players || new_id;
  end loop;

  for n in 0 .. 3 loop
    insert into event_teams (event_id, name, position)
    values (demo, 'Team ' || (n + 1), n)
    returning id into new_id;

    teams := teams || new_id;

    insert into event_team_members (team_id, player_id)
    values (new_id, players[n * 2 + 1]),
           (new_id, players[n * 2 + 2]);
  end loop;

  for n in 0 .. 1 loop
    insert into event_tee_times (event_id, tee_at, position)
    values (demo, time '08:00' + make_interval(mins => n * 10), n)
    returning id into new_id;

    insert into event_tee_time_teams (tee_time_id, team_id, position)
    values (new_id, teams[n * 2 + 1], 0),
           (new_id, teams[n * 2 + 2], 1);
  end loop;
end;
$seed$;
