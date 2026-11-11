/*
  Weeks played on the back nine.

  A week records the hole it starts on: 1, or 10 for a nine played on the
  back of an 18-hole course. Its scores keep their real hole numbers, 10–18,
  so pars, stroke indexes and yardages come from the right half of the card
  and editing the course never touches the wrong holes.

  - The hole-order rule counts from the week's first hole, and now also
    refuses a hole outside the week (hole 10 on a front-nine week).
  - Starting a new week can choose the back nine.
  - league_season and player_rounds say where each week starts.
*/

alter table rounds
  add column if not exists start_hole smallint not null default 1
    check (start_hole in (1, 10));

-- --------------------------------------------------- sequential hole entry

-- Blocks creating a gap. Corrections to an already-entered hole are UPDATEs and
-- pass through untouched, so a scorer can fix hole 3 while standing on the 7th.
create or replace function enforce_sequential_holes()
returns trigger
language plpgsql
as $fn$
declare
  entered_before int;
  first_hole     int;
  last_hole      int;
begin
  if is_admin() then
    return new;
  end if;

  select start_hole, start_hole + hole_count - 1
    into first_hole, last_hole
    from rounds where id = new.round_id;

  first_hole := coalesce(first_hole, 1);

  if new.hole < first_hole or new.hole > coalesce(last_hole, new.hole) then
    raise exception 'This week is holes % to %.', first_hole, last_hole
      using errcode = 'check_violation';
  end if;

  select count(*) into entered_before
    from scores
   where round_id = new.round_id
     and player_id = new.player_id
     and hole >= first_hole
     and hole < new.hole;

  if entered_before <> new.hole - first_hole then
    raise exception
      'Hole % cannot be entered yet: holes %-% must be filled in first.',
      new.hole, first_hole, new.hole - 1
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

-- ------------------------------------------------------ starting a week

/*
  As in 0036, plus the first hole. Left out, it carries over from the week
  before when nothing else about the holes changed, and is otherwise hole 1.
  Only a nine can start on 10, and only on a course with 18 holes.
*/
drop function if exists owner_start_new_week(text, date, boolean, uuid, integer);

create or replace function owner_start_new_week(
  in_name        text,
  in_played_on   date,
  in_copy_groups boolean default true,
  in_course_id   uuid default null,
  in_hole_count  integer default null,
  in_start_hole  integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  prev       rounds%rowtype;
  new_round  uuid;
  shift      interval;
  tt         record;
  new_tee    uuid;
  course     uuid;
  course_max integer;
  holes      integer;
  start      integer;
  stake      integer := coalesce((select default_skins_stake from league_settings), 0);
begin
  if not is_owner() then
    raise exception 'Only the league owner can start a new week.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the week a name.' using errcode = 'check_violation';
  end if;

  select * into prev
    from rounds order by played_on desc, created_at desc limit 1;

  if not found then
    raise exception 'There is no week to carry forward yet.'
      using errcode = 'no_data_found';
  end if;

  if in_played_on is null or in_played_on <= prev.played_on then
    raise exception 'The new week has to come after %.', prev.played_on
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from seasons where year = extract(year from in_played_on)::integer) then
    raise exception 'The % season is closed. Reopen it on the admin page to add a week.',
      extract(year from in_played_on)::integer
      using errcode = 'check_violation';
  end if;

  course := coalesce(in_course_id, prev.course_id);

  if in_course_id is not null then
    select hole_count into course_max from courses where id = in_course_id;

    if course_max is null then
      raise exception 'No such course.' using errcode = 'no_data_found';
    end if;
  else
    select hole_count into course_max from courses where id = course;
  end if;

  holes := coalesce(
    in_hole_count,
    case when course is not distinct from prev.course_id then prev.hole_count
         else least(coalesce(course_max, 18), 18) end
  );

  if holes not in (9, 18) then
    raise exception 'A week is 9 or 18 holes.' using errcode = 'check_violation';
  end if;

  start := coalesce(
    in_start_hole,
    case when in_hole_count is null and course is not distinct from prev.course_id
         then prev.start_hole else 1 end
  );

  if start not in (1, 10) then
    raise exception 'A week starts on hole 1 or hole 10.' using errcode = 'check_violation';
  end if;

  if start = 10 and holes <> 9 then
    raise exception 'Only a nine can be played on the back.' using errcode = 'check_violation';
  end if;

  if start + holes - 1 > coalesce(course_max, 18) then
    raise exception 'That course only has % holes.', course_max using errcode = 'check_violation';
  end if;

  -- rounds_get_settings creates this week's round_settings row.
  insert into rounds (name, played_on, hole_count, start_hole, status, course_id, format)
  values (btrim(in_name), in_played_on, holes, start,
          case when in_copy_groups then 'live' else 'setup' end,
          course, prev.format)
  returning id into new_round;

  if in_copy_groups then
    shift := (in_played_on - prev.played_on) * interval '1 day';

    for tt in
      select id, tee_at
        from tee_times where round_id = prev.id order by tee_at
    loop
      insert into tee_times (round_id, tee_at, starting_hole)
      values (new_round, tt.tee_at + shift, start)
      returning id into new_tee;

      insert into tee_time_players (tee_time_id, round_id, player_id, position)
      select new_tee, new_round, player_id, position
        from tee_time_players where tee_time_id = tt.id;

      insert into scorer_assignments (tee_time_id, scored_player_id, scorer_player_id)
      select new_tee, scored_player_id, scorer_player_id
        from scorer_assignments where tee_time_id = tt.id;
    end loop;
  end if;

  update round_settings ns
     set skins_enabled = os.skins_enabled,
         skins_stake   = case when stake > 0 then stake else os.skins_stake end
    from round_settings os
   where ns.round_id = new_round
     and os.round_id = prev.id;

  update rounds set status = 'final' where id = prev.id and status <> 'final';

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'round', new_round::text,
          jsonb_build_object('name', btrim(in_name), 'played_on', in_played_on,
                             'carried_from', prev.id, 'copied_groups', in_copy_groups,
                             'course_id', course, 'holes', holes, 'start_hole', start));

  return new_round;
end;
$fn$;

-- ----------------------------------------------------------- the season

/* As in 0036, plus startHole on each week. */
create or replace function league_season(in_year integer default null)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  season integer := coalesce(in_year, extract(year from current_date)::integer);
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'year', season,
    'leagueSkins', coalesce((select skins_enabled from league_settings), true),

    'rules', coalesce((
      select jsonb_build_object(
               'points',          points_table,
               'completionPoint', completion_point,
               'dropWorst',       drop_worst,
               'minWeeks',        min_weeks,
               'ranking',         ranking,
               'guestsScore',     guests_score)
        from league_settings
    ), '{}'::jsonb),

    'years', coalesce((
      select jsonb_agg(y.year order by y.year desc)
        from (select distinct extract(year from played_on)::integer as year from rounds) as y
    ), '[]'::jsonb),

    'closed', (
      select jsonb_build_object(
               'closedAt',     s.closed_at,
               'championId',   s.champion_id,
               'championName', s.champion_name)
        from seasons s
       where s.year = season
    ),

    'players', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', p.id,
                 'name', p.full_name,
                 'handicapIndex', p.handicap_index,
                 'preferredTee', p.preferred_tee,
                 'isGuest', p.is_guest
               ) order by p.full_name)
        from profiles p
    ), '[]'::jsonb),

    'rounds', coalesce((
      select jsonb_agg(w.entry order by w.played_on, w.created_at)
        from (
          select rd.played_on,
                 rd.created_at,
                 jsonb_build_object(
                   'id',                 rd.id,
                   'name',               rd.name,
                   'playedOn',           rd.played_on,
                   'status',             rd.status,
                   'holeCount',          rd.hole_count,
                   'startHole',          rd.start_hole,
                   'countsForStandings', rd.counts_for_standings,
                   'skinsEnabled',       coalesce(rs.skins_enabled, true),
                   'skinsStake',         coalesce(rs.skins_stake, 0),
                   'pars', coalesce((
                     select jsonb_object_agg(ch.hole::text, ch.par)
                       from course_holes ch where ch.course_id = rd.course_id
                   ), '{}'::jsonb),
                   'strokeIndexes', coalesce((
                     select jsonb_object_agg(ch.hole::text, ch.handicap_index)
                       from course_holes ch
                      where ch.course_id = rd.course_id
                        and ch.handicap_index is not null
                   ), '{}'::jsonb),
                   'tees', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'tee',          coalesce(ct.tee_color, ct.tee_key),
                                'courseRating', ct.course_rating,
                                'slope',        ct.slope,
                                'yardage',      ct.yardage))
                       from course_tees ct where ct.course_id = rd.course_id
                   ), '[]'::jsonb),
                   'groups', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id', t.id,
                                'playerIds', coalesce((
                                  select jsonb_agg(ttp.player_id order by ttp.position)
                                    from tee_time_players ttp where ttp.tee_time_id = t.id
                                ), '[]'::jsonb),
                                'playedTees', coalesce((
                                  select jsonb_object_agg(ttp.player_id::text, ttp.played_tee)
                                    from tee_time_players ttp
                                   where ttp.tee_time_id = t.id and ttp.played_tee is not null
                                ), '{}'::jsonb)
                              ) order by t.tee_at)
                       from tee_times t where t.round_id = rd.id
                   ), '[]'::jsonb),
                   'scores', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'playerId', s.player_id,
                                'hole',     s.hole,
                                'strokes',  s.strokes))
                       from scores s where s.round_id = rd.id
                   ), '[]'::jsonb)
                 ) as entry
            from rounds rd
            left join round_settings rs on rs.round_id = rd.id
           where extract(year from rd.played_on) = season
        ) as w
    ), '[]'::jsonb)
  );
end;
$fn$;

-- ------------------------------------------------------ a player's rounds

/* As in 0025, plus startHole, so a back-nine round's card shows holes 10–18. */
create or replace function player_rounds(in_player_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(r order by r.played_on desc)
      from (
        select jsonb_build_object(
                 'roundId',   rd.id,
                 'name',      rd.name,
                 'playedOn',  rd.played_on,
                 'status',    rd.status,
                 'courseName', co.name,
                 'holeCount', rd.hole_count,
                 'startHole', rd.start_hole,
                 -- The tee played, then whatever the player's preference
                 -- resolves to on this course, then nothing.
                 'tee', coalesce(
                          ttp.played_tee,
                          resolve_tee_preference(rd.course_id, pr.preferred_tee)
                        ),
                 'courseRating', ct.course_rating,
                 'slope', ct.slope,
                 'coursePar', (
                   select sum(ch.par) from course_holes ch
                    where ch.course_id = rd.course_id
                 ),
                 'scores', coalesce((
                   select jsonb_object_agg(s.hole::text, s.strokes)
                     from scores s
                    where s.round_id = rd.id and s.player_id = in_player_id
                 ), '{}'::jsonb),
                 'pars', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.par)
                     from course_holes ch where ch.course_id = rd.course_id
                 ), '{}'::jsonb),
                 'strokeIndexes', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.handicap_index)
                     from course_holes ch
                    where ch.course_id = rd.course_id
                      and ch.handicap_index is not null
                 ), '{}'::jsonb)
               ) as r,
               rd.played_on
          from rounds rd
          join tee_time_players ttp
            on ttp.round_id = rd.id and ttp.player_id = in_player_id
          join profiles pr on pr.id = in_player_id
          left join courses co on co.id = rd.course_id
          left join lateral (
            -- The rated set matching the tee played, longest when a course
            -- rates the same colour more than once.
            select ct2.course_rating, ct2.slope
              from course_tees ct2
             where ct2.course_id = rd.course_id
               and lower(coalesce(ct2.tee_color, ct2.tee_key))
                   = lower(coalesce(
                       ttp.played_tee,
                       resolve_tee_preference(rd.course_id, pr.preferred_tee),
                       ''
                     ))
             order by ct2.yardage desc nulls last
             limit 1
          ) ct on true
         where exists (
           select 1 from scores s
            where s.round_id = rd.id and s.player_id = in_player_id
         )
      ) as r
  ), '[]'::jsonb);
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function owner_start_new_week(text, date, boolean, uuid, integer, integer) from public, anon;
grant execute on function owner_start_new_week(text, date, boolean, uuid, integer, integer) to authenticated;
