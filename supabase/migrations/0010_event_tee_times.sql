-- Tee times for events.
--
-- A tee time holds four players and never splits a team, so it groups whole
-- teams: four singles, two pairs, or one foursome. Three-man play is the
-- exception -- three does not divide four -- and goes off as a threesome.

create table event_tee_times (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references events on delete cascade,
  -- Time of day; an event is a single day, so a date would be noise.
  tee_at   time not null,
  position smallint not null default 0
);

create index event_tee_times_event on event_tee_times (event_id, tee_at);

create table event_tee_time_teams (
  tee_time_id uuid not null references event_tee_times on delete cascade,
  team_id     uuid not null references event_teams on delete cascade,
  position    smallint not null default 0,
  primary key (tee_time_id, team_id),
  -- A team plays in exactly one tee time.
  unique (team_id)
);

alter table event_tee_times      enable row level security;
alter table event_tee_time_teams enable row level security;

-- Anonymous scorers reach these through event_state, never directly.
create policy admin_event_tee_times on event_tee_times for all to authenticated
  using (is_admin()) with check (is_admin());

create policy admin_event_tee_time_teams on event_tee_time_teams for all to authenticated
  using (is_admin()) with check (is_admin());

-- Fold tee times into the event payload the scoring page already fetches.
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
    'event', (
      select to_jsonb(e) - 'share_token' - 'created_by'
        from events e where e.id = target
    ),
    'players', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.position, p.name)
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
