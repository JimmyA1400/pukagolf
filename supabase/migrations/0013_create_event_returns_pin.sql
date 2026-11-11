-- create_event now returns the share link AND the admin PIN.
--
-- The PIN is shown to the organiser exactly once, here. Only its bcrypt hash is
-- stored, so it cannot be recovered later — if it is lost, a new one has to be
-- set rather than looked up. That is the point of hashing it.
--
-- The return type changes from text to jsonb, which CREATE OR REPLACE cannot
-- do, hence the drop.

drop function if exists create_event(jsonb);

create function create_event(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  new_event    uuid;
  player_ids   uuid[] := '{}';
  team_ids     uuid[] := '{}';
  player_name  text;
  team_json    jsonb;
  new_team     uuid;
  member_index jsonb;
  team_size    int;
  expected     int;
  per_slot     int;
  first_tee    time := coalesce((payload ->> 'first_tee')::time, '08:10');
  interval_min int  := coalesce((payload ->> 'interval_minutes')::int, 10);
  slot         int  := 0;
  i            int;
  slot_member  int;
  new_tee      uuid;
  pin          text := generate_event_pin();
begin
  if not is_admin() then
    raise exception 'Only an admin can create an event.';
  end if;

  if jsonb_array_length(payload -> 'players') < 1 then
    raise exception 'An event needs at least one player.';
  end if;

  insert into events (
    name, played_on, format, hole_count, course_id, course_name,
    location_name, latitude, longitude, created_by, admin_pin_hash
  )
  values (
    btrim(payload ->> 'name'),
    (payload ->> 'played_on')::date,
    (payload ->> 'format')::scoring_format,
    coalesce((payload ->> 'hole_count')::smallint, 18),
    nullif(payload ->> 'course_id', '')::uuid,
    payload ->> 'course_name',
    payload ->> 'location_name',
    (payload ->> 'latitude')::double precision,
    (payload ->> 'longitude')::double precision,
    auth.uid(),
    crypt(pin, gen_salt('bf'))
  )
  returning id into new_event;

  for player_name in select jsonb_array_elements_text(payload -> 'players') loop
    insert into event_players (event_id, name, position)
    values (new_event, btrim(player_name), coalesce(array_length(player_ids, 1), 0))
    returning id into new_team;

    player_ids := player_ids || new_team;
  end loop;

  expected := case payload ->> 'format'
                when 'solo' then 1
                when 'scramble_2' then 2
                when 'best_ball_2' then 2
                when 'scramble_3' then 3
                when 'best_ball_3' then 3
                else 4
              end;

  for team_json in select * from jsonb_array_elements(payload -> 'teams') loop
    team_size := jsonb_array_length(team_json -> 'members');

    if team_size < 1 or team_size > expected then
      raise exception
        'A team has % players; this format allows at most %.', team_size, expected
        using errcode = 'check_violation';
    end if;

    insert into event_teams (event_id, name, position)
    values (
      new_event, team_json ->> 'name',
      coalesce((team_json ->> 'position')::smallint, 0)
    )
    returning id into new_team;

    team_ids := team_ids || new_team;

    for member_index in select * from jsonb_array_elements(team_json -> 'members') loop
      insert into event_team_members (team_id, player_id)
      values (new_team, player_ids[(member_index::int) + 1]);
    end loop;
  end loop;

  -- Whole teams only, four players to a tee time where the size divides in.
  per_slot := greatest(1, 4 / expected);

  i := 1;
  while i <= coalesce(array_length(team_ids, 1), 0) loop
    insert into event_tee_times (event_id, tee_at, position)
    values (
      new_event,
      first_tee + (slot * interval_min || ' minutes')::interval,
      slot
    )
    returning id into new_tee;

    -- A separate counter: a plpgsql FOR loop shadows an outer variable of the
    -- same name, which would leave `i` untouched and spin forever.
    slot_member := i;
    while slot_member <= least(i + per_slot - 1, array_length(team_ids, 1)) loop
      insert into event_tee_time_teams (tee_time_id, team_id, position)
      values (new_tee, team_ids[slot_member], slot_member - i);

      slot_member := slot_member + 1;
    end loop;

    i := i + per_slot;
    slot := slot + 1;
  end loop;

  return jsonb_build_object(
    'share_token', (select share_token from events where id = new_event),
    'admin_pin', pin
  );
end;
$fn$;

revoke execute on function create_event(jsonb) from anon;
grant execute on function create_event(jsonb) to authenticated;
