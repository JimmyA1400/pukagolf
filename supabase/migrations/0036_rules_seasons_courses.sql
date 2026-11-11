/*
  League rules, season control, and a course for each week.

  - The owner sets how a season is scored: points per place, the point for
    finishing below them, how many of each player's worst weeks are dropped,
    how many weeks it takes to qualify, net or gross, and whether guests
    score. The standings are worked out from the scores every time
    (src/lib/standings.ts), so a rule change shows everywhere at once and can
    be changed back; nothing is stored but the rules.
  - A week can be marked rained out: it stays, but doesn't count.
  - A season can be closed, which records its champion and stops weeks being
    added to that year by mistake. league_season lists every year for the
    Standings tab's picker.
  - Starting a new week can pick the course and 18 or 9 holes, and new weeks
    can start at a league default skins stake.
*/

-- ----------------------------------------------------------------- rules

alter table league_settings
  add column if not exists points_table        smallint[] not null default '{10,8,6,5,4,3,2}',
  add column if not exists completion_point    smallint   not null default 1,
  add column if not exists drop_worst          smallint   not null default 0,
  add column if not exists min_weeks           smallint   not null default 0,
  add column if not exists ranking             text       not null default 'net'
    check (ranking in ('net', 'gross')),
  add column if not exists guests_score        boolean    not null default false,
  add column if not exists default_skins_stake integer    not null default 0;

create or replace function owner_set_league_rules(
  in_points        integer[],
  in_completion    integer,
  in_drop_worst    integer,
  in_min_weeks     integer,
  in_ranking       text,
  in_guests_score  boolean,
  in_default_stake integer
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can change the rules.'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(array_length(in_points, 1), 0) not between 1 and 12 then
    raise exception 'Points go to between 1 and 12 places.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from unnest(in_points) as p where p is null or p not between 0 and 100) then
    raise exception 'Points are whole numbers from 0 to 100.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from generate_subscripts(in_points, 1) as i
              where i > 1 and in_points[i] > in_points[i - 1]) then
    raise exception 'Points can''t go up further down the table.' using errcode = 'check_violation';
  end if;

  if in_completion is null or in_completion not between 0 and 10 then
    raise exception 'The finishing point runs from 0 to 10.' using errcode = 'check_violation';
  end if;

  if in_drop_worst is null or in_drop_worst not between 0 and 20 then
    raise exception 'Dropped weeks run from 0 to 20.' using errcode = 'check_violation';
  end if;

  if in_min_weeks is null or in_min_weeks not between 0 and 52 then
    raise exception 'Weeks to qualify run from 0 to 52.' using errcode = 'check_violation';
  end if;

  if in_ranking is null or in_ranking not in ('net', 'gross') then
    raise exception 'Rank by net or gross.' using errcode = 'check_violation';
  end if;

  if in_default_stake is null or in_default_stake not between 0 and 1000 then
    raise exception 'The skins stake runs from 0 to 1000.' using errcode = 'check_violation';
  end if;

  update league_settings
     set points_table        = in_points::smallint[],
         completion_point    = in_completion,
         drop_worst          = in_drop_worst,
         min_weeks           = in_min_weeks,
         ranking             = in_ranking,
         guests_score        = coalesce(in_guests_score, false),
         default_skins_stake = in_default_stake,
         updated_at          = now();

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_settings', 'rules',
          jsonb_build_object('points', in_points, 'completion', in_completion,
                             'drop_worst', in_drop_worst, 'min_weeks', in_min_weeks,
                             'ranking', in_ranking, 'guests_score', in_guests_score,
                             'default_stake', in_default_stake));
end;
$fn$;

-- --------------------------------------------------------------- rain-outs

alter table rounds add column if not exists counts_for_standings boolean not null default true;

create or replace function owner_set_round_counts(in_round_id uuid, in_counts boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  week_name text;
begin
  if not is_owner() then
    raise exception 'Only the league owner can change what counts.'
      using errcode = 'insufficient_privilege';
  end if;

  update rounds set counts_for_standings = coalesce(in_counts, true)
   where id = in_round_id
  returning name into week_name;

  if week_name is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('name', week_name, 'counts_for_standings', coalesce(in_counts, true)));
end;
$fn$;

-- ------------------------------------------------------------------ seasons

/* A closed season, and who won it. Readable by the league; written only below. */
create table if not exists seasons (
  year          integer primary key check (year between 2000 and 2100),
  closed_at     timestamptz not null default now(),
  champion_id   uuid references profiles on delete set null,
  champion_name text
);

alter table seasons enable row level security;

create policy read_seasons on seasons for select to authenticated using (true);

create or replace function owner_close_season(in_year integer, in_champion_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  who text;
begin
  if not is_owner() then
    raise exception 'Only the league owner can close a season.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_year is null or in_year not between 2000 and 2100 then
    raise exception 'Pick a season.' using errcode = 'check_violation';
  end if;

  if in_champion_id is not null then
    select full_name into who from profiles where id = in_champion_id;

    if who is null then
      raise exception 'No such player.' using errcode = 'no_data_found';
    end if;
  end if;

  insert into seasons (year, closed_at, champion_id, champion_name)
  values (in_year, now(), in_champion_id, who)
  on conflict (year) do update
     set closed_at = excluded.closed_at,
         champion_id = excluded.champion_id,
         champion_name = excluded.champion_name;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'close', 'season', in_year::text,
          jsonb_build_object('champion', who));
end;
$fn$;

create or replace function owner_reopen_season(in_year integer)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can reopen a season.'
      using errcode = 'insufficient_privilege';
  end if;

  delete from seasons where year = in_year;

  if not found then
    raise exception 'That season isn''t closed.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'reopen', 'season', in_year::text, '{}'::jsonb);
end;
$fn$;

-- ----------------------------------------------------------- the season

/*
  As in 0034, plus the rules, every year with a week in it, whether this one
  is closed, which players are guests and which weeks count.
*/
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

-- ------------------------------------------------------ starting a week

/*
  owner_start_new_week gains a course and a hole count. Left out, both carry
  over from the week before; a different course brings its own hole count
  unless 9 is asked for. The skins stake starts at the league default when
  there is one, otherwise it carries over as before. A closed season takes
  no new weeks.
*/
drop function if exists owner_start_new_week(text, date, boolean);

create or replace function owner_start_new_week(
  in_name        text,
  in_played_on   date,
  in_copy_groups boolean default true,
  in_course_id   uuid default null,
  in_hole_count  integer default null
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

  if holes > coalesce(course_max, 18) then
    raise exception 'That course only has % holes.', course_max using errcode = 'check_violation';
  end if;

  -- rounds_get_settings creates this week's round_settings row.
  insert into rounds (name, played_on, hole_count, status, course_id, format)
  values (btrim(in_name), in_played_on, holes,
          case when in_copy_groups then 'live' else 'setup' end,
          course, prev.format)
  returning id into new_round;

  if in_copy_groups then
    shift := (in_played_on - prev.played_on) * interval '1 day';

    for tt in
      select id, tee_at, starting_hole
        from tee_times where round_id = prev.id order by tee_at
    loop
      insert into tee_times (round_id, tee_at, starting_hole)
      values (new_round, tt.tee_at + shift, tt.starting_hole)
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
                             'course_id', course, 'holes', holes));

  return new_round;
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function owner_set_league_rules(integer[], integer, integer, integer, text, boolean, integer) from public, anon;
revoke execute on function owner_set_round_counts(uuid, boolean) from public, anon;
revoke execute on function owner_close_season(integer, uuid) from public, anon;
revoke execute on function owner_reopen_season(integer) from public, anon;
revoke execute on function owner_start_new_week(text, date, boolean, uuid, integer) from public, anon;

grant execute on function owner_set_league_rules(integer[], integer, integer, integer, text, boolean, integer) to authenticated;
grant execute on function owner_set_round_counts(uuid, boolean) to authenticated;
grant execute on function owner_close_season(integer, uuid) to authenticated;
grant execute on function owner_reopen_season(integer) to authenticated;
grant execute on function owner_start_new_week(text, date, boolean, uuid, integer) to authenticated;
