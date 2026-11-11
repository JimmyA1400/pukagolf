/*
  Events inside the league: an invited roster, and no anonymous way in.

  An outing is reached by an unguessable link and scored by whoever holds it.
  A league event is the opposite — it belongs to the league, its roster is
  invited, and it shows on the players' profiles — so the first thing here is
  shutting the anonymous door on it. event_state() is the function anon calls
  with a share token; it now refuses a league event outright. Every league
  event is read through league_event(), which requires a signed-in member.

  The draft itself is not in here. Teams are worked out by the shared engine
  in src/lib/formats/, the same code a league week uses, and this file only
  stores the answer. Writing a second snake draft in plpgsql is exactly the
  drift the shared Team type exists to prevent.
*/

-- ------------------------------------------------------- shut the anon door

/*
  As in 0019, plus two things: a league event is not reachable with a share
  token at all, and the payload carries the new format columns so the outing
  pages can move onto the shared registry without another change here.
*/
create or replace function event_state(token text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  target uuid := event_id_for_token(token);
  kind   text;
begin
  if target is null then
    raise exception 'No event found for that link.' using errcode = 'no_data_found';
  end if;

  select scope into kind from events where id = target;

  -- A league event has a share_token like every other row, but it is not a
  -- way in: its roster is invited and its results reach real profiles. Anyone
  -- holding the link still has to sign in and be on the roster.
  if kind = 'league' then
    raise exception 'That event is inside the league. Sign in to see it.'
      using errcode = 'insufficient_privilege';
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
               'format_id', e.format_id,
               'team_size', e.team_size,
               'scope', e.scope,
               'is_simulator', e.is_simulator,
               'start_hole', e.start_hole,
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

-- ------------------------------------------------------------- creating one

create or replace function owner_create_league_event(
  in_name         text,
  in_played_on    date,
  in_course_id    uuid default null,
  in_hole_count   integer default 18,
  in_start_hole   integer default 1,
  in_is_simulator boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  fresh uuid;
  holes integer := coalesce(in_hole_count, 18);
begin
  if not is_admin() then
    raise exception 'Only an admin can create an event.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the event a name.' using errcode = 'check_violation';
  end if;

  if in_played_on is null then
    raise exception 'Give the event a date.' using errcode = 'check_violation';
  end if;

  if holes not in (9, 18) then
    raise exception 'An event is 9 or 18 holes.' using errcode = 'check_violation';
  end if;

  if coalesce(in_start_hole, 1) not in (1, 10) then
    raise exception 'An event starts on hole 1 or hole 10.' using errcode = 'check_violation';
  end if;

  insert into events (name, played_on, format, format_id, team_size, scope,
                      hole_count, start_hole, is_simulator, course_id, course_name,
                      created_by)
  values (btrim(in_name), in_played_on, 'solo', 'stroke', 1, 'league',
          holes, coalesce(in_start_hole, 1), coalesce(in_is_simulator, false),
          in_course_id,
          (select name from courses where id = in_course_id),
          auth.uid())
  returning id into fresh;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'event', fresh::text,
          jsonb_build_object('name', btrim(in_name), 'played_on', in_played_on,
                             'scope', 'league', 'simulator', coalesce(in_is_simulator, false)));

  return fresh;
end;
$fn$;

/* Guards every admin_event_* function below: an admin, on a league event. */
create or replace function assert_league_event(in_event_id uuid)
returns void
language plpgsql
set search_path = public
as $fn$
declare
  kind text;
begin
  if not is_admin() then
    raise exception 'Only an admin can change an event.'
      using errcode = 'insufficient_privilege';
  end if;

  select scope into kind from events where id = in_event_id;

  if kind is null then
    raise exception 'No such event.' using errcode = 'no_data_found';
  end if;

  -- An outing is administered through its own PIN, not from in here.
  if kind <> 'league' then
    raise exception 'That is an outing. Open it with its own link to change it.'
      using errcode = 'check_violation';
  end if;
end;
$fn$;

-- ------------------------------------------------------------- the roster

/*
  Invite league members.

  Idempotent: inviting someone already on the roster leaves their answer
  alone, so re-sending an invitation can't quietly reset an "out" to
  undecided.
*/
create or replace function admin_event_invite(in_event_id uuid, in_profile_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  added integer;
  seat  integer;
begin
  perform assert_league_event(in_event_id);

  select coalesce(max(position), -1) + 1 into seat
    from event_players where event_id = in_event_id;

  insert into event_players (event_id, name, position, profile_id, status)
  select in_event_id, p.full_name,
         seat + (row_number() over (order by p.full_name))::integer - 1,
         p.id, 'undecided'::rsvp_status
    from profiles p
   where p.id = any(in_profile_ids)
     and not exists (select 1 from event_players x
                      where x.event_id = in_event_id and x.profile_id = p.id)
  on conflict do nothing;

  get diagnostics added = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'event', in_event_id::text,
          jsonb_build_object('invited', added));

  return added;
end;
$fn$;

/* A guest at a league event: a name on the sheet, with no account behind it. */
create or replace function admin_event_add_guest(
  in_event_id uuid,
  in_name     text,
  in_handicap numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  fresh uuid;
  clean text := btrim(coalesce(in_name, ''));
begin
  perform assert_league_event(in_event_id);

  if length(clean) not between 2 and 60 then
    raise exception 'Give the guest a name.' using errcode = 'check_violation';
  end if;

  insert into event_players (event_id, name, position, status)
  values (in_event_id, clean,
          coalesce((select max(position) + 1 from event_players where event_id = in_event_id), 0),
          'in'::rsvp_status)
  returning id into fresh;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'guest', fresh::text,
          jsonb_build_object('name', clean, 'event_id', in_event_id,
                             'handicap', in_handicap));

  return fresh;
end;
$fn$;

create or replace function admin_event_remove_player(in_event_id uuid, in_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_league_event(in_event_id);

  if exists (select 1 from event_scores
              where event_id = in_event_id and player_id = in_player_id) then
    raise exception 'They already have scores in this event. Clear those first.'
      using errcode = 'check_violation';
  end if;

  delete from event_players where event_id = in_event_id and id = in_player_id;

  if not found then
    raise exception 'They are not on this roster.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'delete', 'event_player', in_player_id::text,
          jsonb_build_object('event_id', in_event_id));
end;
$fn$;

/* A player answers for themselves; an admin answers for anyone. */
create or replace function event_rsvp(
  in_event_id uuid,
  in_status   text,
  in_player_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  seat uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if in_status not in ('in', 'out', 'undecided') then
    raise exception 'An answer is in, out or undecided.' using errcode = 'check_violation';
  end if;

  if in_player_id is null then
    select id into seat from event_players
     where event_id = in_event_id and profile_id = auth.uid();

    if seat is null then
      raise exception 'You are not invited to that event.'
        using errcode = 'insufficient_privilege';
    end if;
  else
    if not is_admin() then
      raise exception 'Only an admin can answer for somebody else.'
        using errcode = 'insufficient_privilege';
    end if;
    seat := in_player_id;
  end if;

  update event_players set status = in_status::rsvp_status
   where id = seat and event_id = in_event_id;
end;
$fn$;

-- -------------------------------------------------------------- the format

create or replace function admin_event_set_format(
  in_event_id  uuid,
  in_format_id text,
  in_team_size integer
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_league_event(in_event_id);

  /*
    Only that the format exists and the size is playable at all. Whether this
    format is played at this size is a warning, not a refusal — the admin is
    told and decides, per the setup flow — and that rule lives once, in
    src/lib/formats/registry.ts, rather than being copied into SQL where it
    would drift.
  */
  if in_format_id not in ('stroke', 'net_stroke', 'stableford', 'skins', 'match',
                          'best_ball', 'two_best', 'scramble', 'alt_shot',
                          'greensomes', 'nines') then
    raise exception 'No such format.' using errcode = 'check_violation';
  end if;

  if in_team_size not between 1 and 4 then
    raise exception 'A side holds one to four players.' using errcode = 'check_violation';
  end if;

  update events
     set format_id = in_format_id,
         team_size = in_team_size
   where id = in_event_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'event', in_event_id::text,
          jsonb_build_object('format_id', in_format_id, 'team_size', in_team_size));
end;
$fn$;

create or replace function admin_event_set_flags(
  in_event_id    uuid,
  in_counts      boolean default null,
  in_simulator   boolean default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_league_event(in_event_id);

  update events
     set counts_for_standings = coalesce(in_counts, counts_for_standings),
         is_simulator         = coalesce(in_simulator, is_simulator)
   where id = in_event_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'event', in_event_id::text,
          jsonb_build_object('counts_for_standings', in_counts, 'simulator', in_simulator));
end;
$fn$;

-- --------------------------------------------------------------- the teams

/*
  Store a draft worked out by the shared engine.

  `in_teams` is [[playerId, ...], ...] in finishing order. Replacing the teams
  is refused once anyone has scored: a side that changes under a card already
  posted makes that card belong to nobody.
*/
create or replace function admin_event_set_teams(in_event_id uuid, in_teams jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  side   jsonb;
  fresh  uuid;
  made   integer := 0;
  member jsonb;
begin
  perform assert_league_event(in_event_id);

  if exists (select 1 from event_scores where event_id = in_event_id) then
    raise exception 'This event already has scores, so its teams can''t be rebuilt. Move players one at a time instead.'
      using errcode = 'check_violation';
  end if;

  if jsonb_typeof(in_teams) <> 'array' then
    raise exception 'Teams come as a list of lists of players.'
      using errcode = 'check_violation';
  end if;

  -- Cascades to event_team_members and the tee time assignments.
  delete from event_teams where event_id = in_event_id;

  for side in select * from jsonb_array_elements(in_teams) loop
    made := made + 1;

    insert into event_teams (event_id, position) values (in_event_id, made)
    returning id into fresh;

    for member in select * from jsonb_array_elements(side) loop
      insert into event_team_members (team_id, player_id)
      values (fresh, (member #>> '{}')::uuid);
    end loop;
  end loop;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'event', in_event_id::text,
          jsonb_build_object('teams', made));

  return made;
end;
$fn$;

-- ---------------------------------------------------------------- reading

/*
  A league event, for a signed-in member.

  The roster carries each player's index, because the draft is worked out on
  the client by the shared engine and needs it. Nothing here is reachable
  without a session — see the guard at the top of event_state.
*/
create or replace function league_event(in_event_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  target events%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  select * into target from events where id = in_event_id and scope = 'league';

  if not found then
    raise exception 'No such event.' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', target.id,
      'name', target.name,
      'playedOn', target.played_on,
      'formatId', target.format_id,
      'teamSize', target.team_size,
      'holeCount', target.hole_count,
      'startHole', target.start_hole,
      'isSimulator', target.is_simulator,
      'countsForStandings', target.counts_for_standings,
      'courseId', target.course_id,
      'courseName', target.course_name,
      'skinsEnabled', target.skins_enabled,
      'skinsStake', target.skins_stake
    ),
    'roster', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', ep.id,
                 'profileId', ep.profile_id,
                 'name', ep.name,
                 'position', ep.position,
                 'status', ep.status,
                 'isGuest', ep.profile_id is null,
                 'handicapIndex', pr.handicap_index,
                 'preferredTee', pr.preferred_tee
               ) order by ep.position, ep.name)
        from event_players ep
        left join profiles pr on pr.id = ep.profile_id
       where ep.event_id = target.id
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', t.id, 'name', t.name, 'position', t.position,
                 'memberIds', coalesce((
                   select jsonb_agg(m.player_id)
                     from event_team_members m where m.team_id = t.id
                 ), '[]'::jsonb)
               ) order by t.position)
        from event_teams t where t.event_id = target.id
    ), '[]'::jsonb),
    'teeTimes', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', tt.id, 'teeAt', tt.tee_at, 'position', tt.position,
                 'teamIds', coalesce((
                   select jsonb_agg(x.team_id order by x.position)
                     from event_tee_time_teams x where x.tee_time_id = tt.id
                 ), '[]'::jsonb)
               ) order by tt.tee_at, tt.position)
        from event_tee_times tt where tt.event_id = target.id
    ), '[]'::jsonb),
    'scores', coalesce((
      select jsonb_agg(
               jsonb_build_object('teamId', s.team_id, 'playerId', s.player_id,
                                  'hole', s.hole, 'strokes', s.strokes))
        from event_scores s where s.event_id = target.id
    ), '[]'::jsonb),
    'pars', coalesce((
      select jsonb_object_agg(ch.hole::text, ch.par)
        from course_holes ch where ch.course_id = target.course_id
    ), '{}'::jsonb),
    'strokeIndexes', coalesce((
      select jsonb_object_agg(ch.hole::text, ch.handicap_index)
        from course_holes ch
       where ch.course_id = target.course_id and ch.handicap_index is not null
    ), '{}'::jsonb),
    'tees', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'tee', coalesce(ct.tee_color, ct.tee_key),
                 'courseRating', ct.course_rating,
                 'slope', ct.slope,
                 'yardage', ct.yardage))
        from course_tees ct where ct.course_id = target.course_id
    ), '[]'::jsonb)
  );
end;
$fn$;

/* Every league event, newest first, for the admin's list. */
create or replace function league_events()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id', e.id,
               'name', e.name,
               'playedOn', e.played_on,
               'formatId', e.format_id,
               'teamSize', e.team_size,
               'holeCount', e.hole_count,
               'isSimulator', e.is_simulator,
               'countsForStandings', e.counts_for_standings,
               'courseName', e.course_name,
               'players', (select count(*) from event_players p where p.event_id = e.id),
               'in', (select count(*) from event_players p
                       where p.event_id = e.id and p.status = 'in'),
               'teams', (select count(*) from event_teams t where t.event_id = e.id),
               'scores', (select count(*) from event_scores s where s.event_id = e.id)
             ) order by e.played_on desc, e.created_at desc)
      from events e where e.scope = 'league'
  ), '[]'::jsonb);
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function assert_league_event(uuid) from public, anon, authenticated;
revoke execute on function owner_create_league_event(text, date, uuid, integer, integer, boolean) from public, anon;
revoke execute on function admin_event_invite(uuid, uuid[]) from public, anon;
revoke execute on function admin_event_add_guest(uuid, text, numeric) from public, anon;
revoke execute on function admin_event_remove_player(uuid, uuid) from public, anon;
revoke execute on function event_rsvp(uuid, text, uuid) from public, anon;
revoke execute on function admin_event_set_format(uuid, text, integer) from public, anon;
revoke execute on function admin_event_set_flags(uuid, boolean, boolean) from public, anon;
revoke execute on function admin_event_set_teams(uuid, jsonb) from public, anon;
revoke execute on function league_event(uuid) from public, anon;
revoke execute on function league_events() from public, anon;

grant execute on function owner_create_league_event(text, date, uuid, integer, integer, boolean) to authenticated;
grant execute on function admin_event_invite(uuid, uuid[]) to authenticated;
grant execute on function admin_event_add_guest(uuid, text, numeric) to authenticated;
grant execute on function admin_event_remove_player(uuid, uuid) to authenticated;
grant execute on function event_rsvp(uuid, text, uuid) to authenticated;
grant execute on function admin_event_set_format(uuid, text, integer) to authenticated;
grant execute on function admin_event_set_flags(uuid, boolean, boolean) to authenticated;
grant execute on function admin_event_set_teams(uuid, jsonb) to authenticated;
grant execute on function league_event(uuid) to authenticated;
grant execute on function league_events() to authenticated;
