-- Publish each tee's rating, slope and total yardage to the event surface.
--
-- Selecting a tee has to show that tee's rating and slope, and the dropdown is
-- ordered by length, so the scorecard needs the tee sets and not just the
-- per-hole yardages it already had.

create or replace function event_state(token text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  target uuid := event_id_for_token(token);
begin
  if target is null then
    raise exception 'No event found for that link.' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    -- ALLOWLIST. Never `to_jsonb(e)` here: this table holds admin_pin_hash and
    -- admin_token, and a denylist publishes anything added later by default.
    'event', (
      select jsonb_build_object(
               'id', e.id,
               'name', e.name,
               'played_on', e.played_on,
               'format', e.format,
               'hole_count', e.hole_count,
               'course_id', e.course_id,
               'course_name', e.course_name,
               'location_name', e.location_name,
               'latitude', e.latitude,
               'longitude', e.longitude,
               'skins_enabled', e.skins_enabled,
               'skins_stake', e.skins_stake
             )
        from events e where e.id = target
    ),
    'players', coalesce((
      select jsonb_agg(
               jsonb_build_object('id', p.id, 'name', p.name, 'position', p.position)
               order by p.position, p.name
             )
        from event_players p where p.event_id = target
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', t.id, 'name', t.name, 'position', t.position,
                 'memberIds', coalesce((
                   select jsonb_agg(m.player_id)
                     from event_team_members m where m.team_id = t.id
                 ), '[]'::jsonb)
               ) order by t.position
             )
        from event_teams t where t.event_id = target
    ), '[]'::jsonb),
    'teeTimes', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', tt.id,
                 'teeAt', to_char(tt.tee_at, 'HH12:MI') ||
                          lower(left(to_char(tt.tee_at, 'AM'), 1)),
                 'position', tt.position,
                 'teamIds', coalesce((
                   select jsonb_agg(x.team_id order by x.position)
                     from event_tee_time_teams x where x.tee_time_id = tt.id
                 ), '[]'::jsonb)
               ) order by tt.tee_at
             )
        from event_tee_times tt where tt.event_id = target
    ), '[]'::jsonb),
    -- One row per tee colour. A course lists a rated set per gender; the
    -- longest is taken so the dropdown shows one entry per physical tee.
    'tees', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'tee', picked.tee,
                 'courseRating', picked.course_rating,
                 'slope', picked.slope,
                 'statedYardage', picked.yardage
               )
             )
        from (
          select distinct on (lower(coalesce(ct.tee_color, ct.tee_key)))
                 lower(coalesce(ct.tee_color, ct.tee_key)) as tee,
                 ct.course_rating, ct.slope, ct.yardage
            from course_tees ct
            join events e on e.course_id = ct.course_id
           where e.id = target
           order by lower(coalesce(ct.tee_color, ct.tee_key)),
                    ct.yardage desc nulls last
        ) as picked
    ), '[]'::jsonb),
    'scores', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'teamId', s.team_id, 'playerId', s.player_id,
                 'hole', s.hole, 'strokes', s.strokes, 'enteredBy', s.entered_by
               ) order by s.hole
             )
        from event_scores s where s.event_id = target
    ), '[]'::jsonb),
    'holes', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'hole', h.hole,
                 'par', h.par,
                 'strokeIndex', h.handicap_index,
                 'yardages', coalesce(h.yardages, '{}'::jsonb)
               ) order by h.hole
             )
        from course_holes h
        join events e on e.course_id = h.course_id
       where e.id = target
    ), '[]'::jsonb)
  );
end;
$fn$;

grant execute on function event_state(text) to anon, authenticated;
revoke execute on function event_state(text) from public;
