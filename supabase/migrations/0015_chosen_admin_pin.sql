-- Let the organiser choose the admin PIN at creation.
--
-- A chosen PIN is remembered; a generated one gets written on a hand and lost.
-- But a chosen PIN is also where people put 11111111, and this PIN is the only
-- thing standing between a stranger and rewriting the day's scores — so the
-- obvious ones are refused. Anything else is accepted as given, and one is
-- generated when the field is left blank.

create or replace function pin_is_weak(pin text)
returns boolean
language sql
immutable
as $fn$
  select
    -- Every digit the same: 00000000, 11111111, ...
    pin ~ '^(.)\1{7}$'
    -- Straight runs in either direction, and the keypad classics.
    or pin in (
      '12345678', '87654321', '01234567', '76543210',
      '23456789', '98765432', '12341234', '11223344'
    );
$fn$;

create or replace function create_event(payload jsonb)
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
  chosen       text := nullif(btrim(payload ->> 'admin_pin'), '');
  pin          text;
begin
  if not is_admin() then
    raise exception 'Only an admin can create an event.';
  end if;

  if jsonb_array_length(payload -> 'players') < 1 then
    raise exception 'An event needs at least one player.';
  end if;

  -- Validate a chosen PIN; fall back to a generated one when none was given.
  if chosen is null then
    pin := generate_event_pin();
  else
    if chosen !~ '^\d{8}$' then
      raise exception 'The admin PIN must be exactly 8 digits.'
        using errcode = 'check_violation';
    end if;

    if pin_is_weak(chosen) then
      raise exception
        'That PIN is too easy to guess. Avoid repeated digits and runs like 12345678.'
        using errcode = 'check_violation';
    end if;

    pin := chosen;
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

    -- Separate counter: a plpgsql FOR loop shadows an outer variable of the
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
    'admin_pin', pin,
    'pin_was_chosen', chosen is not null
  );
end;
$fn$;

revoke execute on function create_event(jsonb) from public;
grant execute on function create_event(jsonb) to authenticated;
revoke execute on function pin_is_weak(text) from public;
