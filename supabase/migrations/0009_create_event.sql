-- Create a whole event in one call.
--
-- An event is four tables: the event, its roster, its teams, and who is on
-- which team. Creating them one round trip at a time would leave a
-- half-built event behind whenever a request failed midway, and there is no
-- sensible way for the admin to recover from that in the UI.
--
-- Teams reference players by their index in the roster array, so the caller
-- doesn't need ids that only exist after the insert.

create or replace function create_event(payload jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  new_event    uuid;
  player_ids   uuid[] := '{}';
  player_name  text;
  team_json    jsonb;
  new_team     uuid;
  member_index jsonb;
  team_size    int;
  expected     int;
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

  -- Roster order is preserved so team indices line up with what the admin saw.
  for player_name in
    select jsonb_array_elements_text(payload -> 'players')
  loop
    insert into event_players (event_id, name, position)
    values (new_event, btrim(player_name), coalesce(array_length(player_ids, 1), 0))
    returning id into new_team;  -- reused as a scratch uuid

    player_ids := player_ids || new_team;
  end loop;

  -- Team size is derived from the format, never trusted from the caller.
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

    for member_index in select * from jsonb_array_elements(team_json -> 'members') loop
      insert into event_team_members (team_id, player_id)
      values (new_team, player_ids[(member_index::int) + 1]);
    end loop;
  end loop;

  return (select share_token from events where id = new_event);
end;
$fn$;

revoke execute on function create_event(jsonb) from anon;
grant execute on function create_event(jsonb) to authenticated;
