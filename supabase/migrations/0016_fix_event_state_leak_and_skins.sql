-- SECURITY FIX: event_state leaked the admin credentials. Plus skins controls.
--
-- THE BUG
-- event_state built its payload with
--
--   to_jsonb(e) - 'share_token' - 'created_by'
--
-- which is a denylist: every column is published unless named. Migration 0012
-- then added admin_pin_hash, admin_token, pin_attempts and pin_locked_until to
-- that same table, so all four went straight out to any anonymous caller
-- holding the share link.
--
-- THE IMPACT
-- admin_token is the credential the admin RPCs accept. Anyone with the link
-- could read it from the response and edit tee times, scores and player names
-- without ever knowing the PIN. admin_pin_hash additionally handed out a bcrypt
-- hash of an 8-digit secret, which is only 100 million candidates offline.
--
-- THE FIX
-- An explicit allowlist. New columns are now invisible until someone chooses to
-- publish them, so this fails closed instead of open. Every exposed admin_token
-- is rotated, because the old values must be assumed compromised.

-- Skins are per-event and adjustable: some outings play them, some don't, and
-- the stake is whatever the group agreed on in the car park.
alter table events
  add column skins_enabled boolean not null default true,
  add column skins_stake   integer not null default 20
                           check (skins_stake >= 0 and skins_stake <= 1000);

-- The league has the same switch; it already had a stake.
alter table round_settings
  add column skins_enabled boolean not null default true;

-- Any token that has been served to a client is burned.
update events
   set admin_token = replace(gen_random_uuid()::text, '-', '');

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
               jsonb_build_object('hole', h.hole, 'par', h.par,
                                  'strokeIndex', h.handicap_index)
               order by h.hole
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

-- Turn skins on or off, and set the stake.
create or replace function event_admin_set_skins(
  admin_token text, in_enabled boolean, in_stake integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := event_for_admin_token(admin_token);
begin
  if target is null then
    raise exception 'Not unlocked for this event.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_stake < 0 or in_stake > 1000 then
    raise exception 'A skins stake must be between $0 and $1000.'
      using errcode = 'check_violation';
  end if;

  update events
     set skins_enabled = in_enabled, skins_stake = in_stake
   where id = target;

  insert into audit_log (actor_label, action, entity, entity_id, detail)
  values ('event admin', 'update', 'event_skins', target::text,
          jsonb_build_object('enabled', in_enabled, 'stake', in_stake));

  return event_state((select share_token from events where id = target));
end;
$fn$;

grant execute on function event_admin_set_skins(text, boolean, integer)
  to anon, authenticated;
revoke execute on function event_admin_set_skins(text, boolean, integer) from public;
