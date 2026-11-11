-- create_event now lays out tee times as well.
--
-- The grouping rule is derived here rather than trusted from the caller, for
-- the same reason team size is: it is a rule about the format, not a
-- preference. Whole teams only, four players to a tee time where the maths
-- allows.

create or replace function create_event(payload jsonb)
returns text
language plpgsql
security definer
set search_path = public
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
begin
  if not is_admin() then
    raise exception 'Only an admin can create an event.';
  end if;

  if jsonb_array_length(payload -> 'players') < 1 then
    raise exception 'An event needs at least one player.';
  end if;

  insert into events (
    name, played_on, format, hole_count, course_id, course_name,
    location_name, latitude, longitude, created_by
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
    auth.uid()
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
      new_event,
      team_json ->> 'name',
      coalesce((team_json ->> 'position')::smallint, 0)
    )
    returning id into new_team;

    team_ids := team_ids || new_team;

    for member_index in select * from jsonb_array_elements(team_json -> 'members') loop
      insert into event_team_members (team_id, player_id)
      values (new_team, player_ids[(member_index::int) + 1]);
    end loop;
  end loop;

  -- Whole teams only. Four players to a tee time where the team size divides
  -- into four; a three-man team goes off as a threesome rather than being
  -- broken up to make the number work.
  per_slot := greatest(1, 4 / expected);

  -- Two counters, deliberately: a plpgsql FOR loop declares its own variable
  -- that shadows an outer one of the same name, so reusing `i` inside would
  -- leave the outer counter untouched and spin forever.
  i := 1;
  while i <= coalesce(array_length(team_ids, 1), 0) loop
    insert into event_tee_times (event_id, tee_at, position)
    values (
      new_event,
      first_tee + (slot * interval_min || ' minutes')::interval,
      slot
    )
    returning id into new_tee;

    slot_member := i;
    while slot_member <= least(i + per_slot - 1, array_length(team_ids, 1)) loop
      insert into event_tee_time_teams (tee_time_id, team_id, position)
      values (new_tee, team_ids[slot_member], slot_member - i);

      slot_member := slot_member + 1;
    end loop;

    i := i + per_slot;
    slot := slot + 1;
  end loop;

  return (select share_token from events where id = new_event);
end;
$fn$;

revoke execute on function create_event(jsonb) from anon;
grant execute on function create_event(jsonb) to authenticated;
