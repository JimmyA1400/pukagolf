/*
  The tee a player played at an event, so an event round can reach a handicap.

  A differential needs the rating and slope of the set actually played. A
  league week has had that on tee_time_players.played_tee all along; an event
  roster had nowhere to put it, which is the only reason events have been
  invisible to the scoring record.

  Three rules decide whether an event round counts, and all three are here
  rather than in the client, because a handicap is the one number in the app
  a player will argue about:

    - Own ball only. A scramble, alternate shot or greensomes card is the
      side's, not the player's, and posting it to their record would corrupt
      their index. Same rule as feedsHandicap() in formats/registry.ts.
    - A league event only. Its roster is invited and an admin runs it; an
      outing is scored by whoever holds the link.
    - An account behind the name. A guest has no record to post to.

  Completeness and the rating are checked on the client, by the same code
  that already does it for a league week, so the two can't disagree.
*/

alter table event_players
  add column if not exists played_tee text
    check (played_tee is null or length(btrim(played_tee)) between 1 and 40);

comment on column event_players.played_tee is
  'Which rated set they played. Without it an event round has no differential and cannot reach a handicap.';

-- --------------------------------------------------------------- setting it

create or replace function admin_event_set_tee(
  in_event_id  uuid,
  in_player_id uuid,
  in_tee       text
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_league_event(in_event_id);

  update event_players
     set played_tee = nullif(btrim(coalesce(in_tee, '')), '')
   where id = in_player_id and event_id = in_event_id;

  if not found then
    raise exception 'They are not on this roster.' using errcode = 'no_data_found';
  end if;
end;
$fn$;

/* A player says which tee they played, for their own seat only. */
create or replace function event_set_my_tee(in_event_id uuid, in_tee text)
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

  select id into seat from event_players
   where event_id = in_event_id and profile_id = auth.uid();

  if seat is null then
    raise exception 'You are not on that roster.' using errcode = 'insufficient_privilege';
  end if;

  update event_players
     set played_tee = nullif(btrim(coalesce(in_tee, '')), '')
   where id = seat;
end;
$fn$;

-- ------------------------------------------------------- into the record

/*
  A player's event rounds, in the shape player_rounds() returns for weeks.

  Kept as its own function rather than folded into player_rounds: the two read
  entirely different tables, and the client concatenates them before working
  out a single index from the lot.
*/
create or replace function player_event_rounds(in_player_id uuid)
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
    select jsonb_agg(r order by r.played_on desc)
      from (
        select jsonb_build_object(
                 'roundId',    ev.id,
                 'name',       ev.name,
                 'playedOn',   ev.played_on,
                 'status',     'final',
                 'courseName', coalesce(co.name, ev.course_name),
                 'holeCount',  ev.hole_count,
                 'startHole',  ev.start_hole,
                 'tee', coalesce(
                          ep.played_tee,
                          resolve_tee_preference(ev.course_id, pr.preferred_tee)
                        ),
                 'courseRating', ct.course_rating,
                 'slope', ct.slope,
                 'coursePar', (
                   select sum(ch.par) from course_holes ch
                    where ch.course_id = ev.course_id
                 ),
                 'scores', coalesce((
                   select jsonb_object_agg(s.hole::text, s.strokes)
                     from event_scores s
                    where s.event_id = ev.id and s.player_id = ep.id
                 ), '{}'::jsonb),
                 'pars', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.par)
                     from course_holes ch where ch.course_id = ev.course_id
                 ), '{}'::jsonb),
                 'strokeIndexes', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.handicap_index)
                     from course_holes ch
                    where ch.course_id = ev.course_id
                      and ch.handicap_index is not null
                 ), '{}'::jsonb),
                 'isSimulator', ev.is_simulator,
                 'isEvent', true
               ) as r,
               ev.played_on
          from events ev
          join event_players ep
            on ep.event_id = ev.id and ep.profile_id = in_player_id
          join profiles pr on pr.id = in_player_id
          left join courses co on co.id = ev.course_id
          left join lateral (
            select ct2.course_rating, ct2.slope
              from course_tees ct2
             where ct2.course_id = ev.course_id
               and lower(coalesce(ct2.tee_color, ct2.tee_key))
                   = lower(coalesce(
                       ep.played_tee,
                       resolve_tee_preference(ev.course_id, pr.preferred_tee),
                       ''
                     ))
             order by ct2.yardage desc nulls last
             limit 1
          ) ct on true
         where ev.scope = 'league'
           -- Own ball only: a shared card is nobody's own score.
           and ev.format_id not in ('scramble', 'alt_shot', 'greensomes')
           and exists (
             select 1 from event_scores s
              where s.event_id = ev.id and s.player_id = ep.id
           )
      ) as r
  ), '[]'::jsonb);
end;
$fn$;

-- ------------------------------------------------------------- reading it

/* As in 0041, plus the tee each player played. */
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
                 'preferredTee', pr.preferred_tee,
                 'playedTee', ep.played_tee
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

-- --------------------------------------------------------------- grants

revoke execute on function admin_event_set_tee(uuid, uuid, text) from public, anon;
revoke execute on function event_set_my_tee(uuid, text) from public, anon;
revoke execute on function player_event_rounds(uuid) from public, anon;

grant execute on function admin_event_set_tee(uuid, uuid, text) to authenticated;
grant execute on function event_set_my_tee(uuid, text) to authenticated;
grant execute on function player_event_rounds(uuid) to authenticated;
