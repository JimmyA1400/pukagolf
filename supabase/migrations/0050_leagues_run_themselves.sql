/*
  Every league runs itself: its own rules, its own weeks, its own seasons.

  Until now there was one set of league rules (league_settings, a single row)
  and every week, season and announcement was the Saturday League's by name.
  This gives each league its own row of rules (league_rules) and makes every
  function that used the one league take the league it is for, checking the
  caller is an admin of that league's club:

    the admin page's overview, starting a week, closing and reopening a
    season, creating a league event, the rules, skins, the first tee and gap,
    and the announcement

  The Saturday League's rules are copied over exactly as they are. A new
  league starts as the standard league: singles, stroke play, ranked gross,
  no skins. Its admins change anything from there.

  A league's first week starts from a course (there is no last week to carry
  forward), so a new club can run its first week.

  Courses: the same course imported by two clubs is now two copies, one each.
  Until now a course's outside id was unique across the whole database, so a
  second club importing it would have rewritten the first club's pars.

  league_settings keeps one thing that really is for the whole site: the
  simulator weight, which feeds every player's handicap wherever they play,
  and is now the platform admin's to set. Its other columns are left where
  they are, unread, so nothing is lost; the rules in them now live in
  league_rules.

  Seasons are keyed by league and year, so two leagues can each have a 2026.
*/

-- ------------------------------------------------------------ league rules

create table league_rules (
  league_id            uuid primary key references leagues on delete cascade,
  points_table         smallint[] not null default '{10,8,6,5,4,3,2}',
  completion_point     smallint   not null default 1,
  drop_worst           smallint   not null default 0,
  min_weeks            smallint   not null default 0,
  ranking              text       not null default 'gross' check (ranking in ('net', 'gross')),
  guests_score         boolean    not null default false,
  default_game         text       not null default 'stroke'
                       check (default_game in ('stroke', 'stableford', 'scramble', 'best_ball')),
  stableford_points    smallint[] not null default '{5,4,3,2,1,0}',
  skins_enabled        boolean    not null default false,
  default_skins_stake  integer    not null default 0,
  first_tee_time       time       not null default '08:00',
  tee_interval_minutes smallint   not null default 10,
  announcement         text,
  announcement_at      timestamptz,
  updated_at           timestamptz not null default now()
);

alter table league_rules enable row level security;

-- Anyone who can see the league reads its rules; every change is a function.
create policy read_league_rules on league_rules for select to authenticated
  using (sees_league(league_id));

-- The Saturday League keeps exactly the rules it has today.
insert into league_rules (league_id, points_table, completion_point, drop_worst, min_weeks,
                          ranking, guests_score, default_game, stableford_points,
                          skins_enabled, default_skins_stake, first_tee_time,
                          tee_interval_minutes, announcement, announcement_at)
select 'b0000000-0000-4000-8000-000000000001', points_table, completion_point, drop_worst,
       min_weeks, ranking, guests_score, default_game, stableford_points, skins_enabled,
       default_skins_stake, first_tee_time, tee_interval_minutes, announcement, announcement_at
  from league_settings;

-- Every other league, already made, starts from the standard.
insert into league_rules (league_id)
select id from leagues where id <> 'b0000000-0000-4000-8000-000000000001'
on conflict do nothing;

-- And every league made from now on.
create or replace function create_league_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into league_rules (league_id) values (new.id) on conflict do nothing;
  return new;
end;
$fn$;

revoke execute on function create_league_rules() from public, anon, authenticated;

create trigger league_rules_on_create
  after insert on leagues
  for each row execute function create_league_rules();

/*
  The old one-row settings stay readable by PukaGolf's members only: its
  columns still hold PukaGolf's old rules and announcement. The one value in
  it for the whole site, the simulator weight, is read through site_settings().
*/
create or replace function site_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object('simulatorWeight', simulator_weight) from league_settings;
$fn$;

revoke execute on function site_settings() from public, anon;
grant execute on function site_settings() to authenticated;

-- ------------------------------------------------------------ seasons

alter table seasons drop constraint seasons_pkey;
alter table seasons add primary key (league_id, year);

-- ------------------------------------------------------------ courses

alter table courses drop constraint if exists courses_external_id_key;
alter table courses add constraint courses_club_external_id_key unique (club_id, external_id);

-- ------------------------------------------------------------ functions

drop function if exists owner_league_overview();
drop function if exists owner_start_new_week(text, date, boolean, uuid, integer, integer, text);
drop function if exists owner_close_season(integer, uuid);
drop function if exists owner_reopen_season(integer);
drop function if exists owner_create_league_event(text, date, uuid, integer, integer, boolean);
drop function if exists owner_set_league_skins(boolean);
drop function if exists owner_set_league_rules(integer[], integer, integer, integer, text, boolean, integer, text, integer[]);
drop function if exists admin_set_tee_defaults(time without time zone, integer);
drop function if exists admin_set_announcement(text);
drop function if exists import_course(jsonb);

-- owner_league_overview: The admin page of the league asked for, for its
-- club's admins: its weeks, and its club's members.
CREATE OR REPLACE FUNCTION public.owner_league_overview(in_league_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  current_id uuid;
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can open this.'
      using errcode = 'insufficient_privilege';
  end if;

  select id into current_id
    from rounds where league_id = in_league_id
   order by played_on desc, created_at desc limit 1;

  return jsonb_build_object(
    'currentRoundId', current_id,

    'rounds', coalesce((
      select jsonb_agg(x.r order by x.played desc, x.created desc)
        from (
          select rd.played_on as played,
                 rd.created_at as created,
                 jsonb_build_object(
                   'id',           rd.id,
                   'name',         rd.name,
                   'playedOn',     rd.played_on,
                   'status',       rd.status,
                   'courseName',   co.name,
                   'holeCount',    rd.hole_count,
                   'scoreCount',   (select count(*) from scores s where s.round_id = rd.id),
                   'playerCount',  (select count(*) from tee_time_players t where t.round_id = rd.id),
                   'feedCount',    (select count(*) from feed_posts f where f.round_id = rd.id),
                   'skinsEnabled', rs.skins_enabled,
                   'skinsStake',   rs.skins_stake
                 ) as r
            from rounds rd
            left join courses co on co.id = rd.course_id
            left join round_settings rs on rs.round_id = rd.id
           where rd.league_id = in_league_id
        ) as x
    ), '[]'::jsonb),

    'players', coalesce((
      select jsonb_agg(y.p order by y.name)
        from (
          select pr.full_name as name,
                 jsonb_build_object(
                   'id',             pr.id,
                   'name',           pr.full_name,
                   'isAdmin',        pr.is_admin,
                   'isOwner',        exists (select 1 from league_owner o where o.profile_id = pr.id),
                   'contact',        coalesce(nullif(u.email, ''), profile_phone(u.phone)),
                   'joined',         pr.created_at::date,
                   'handicapIndex',  pr.handicap_index,
                   'inCurrentRound', exists (
                     select 1 from tee_time_players t
                      where t.round_id = current_id and t.player_id = pr.id
                   ),
                   'roundsPlayed',   (
                     select count(distinct s.round_id) from scores s where s.player_id = pr.id
                   )
                 ) as p
            from profiles pr
            left join auth.users u on u.id = pr.id
           where exists (select 1 from club_members m
                          where m.profile_id = pr.id and m.club_id = league_club(in_league_id)
                            and m.status = 'active')
        ) as y
    ), '[]'::jsonb),

    'demo', (
      select jsonb_build_object(
               'id', e.id,
               'name', e.name,
               'scoreCount', (select count(*) from event_scores es where es.event_id = e.id)
             )
        from events e
       where e.is_demo
       limit 1
    )
  );
end;
$function$;

-- owner_start_new_week: A week in the league asked for. A league's first
-- week starts from a course instead of carrying the last week forward.
CREATE OR REPLACE FUNCTION public.owner_start_new_week(in_league_id uuid, in_name text, in_played_on date, in_copy_groups boolean DEFAULT true, in_course_id uuid DEFAULT NULL::uuid, in_hole_count integer DEFAULT NULL::integer, in_start_hole integer DEFAULT NULL::integer, in_game text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  week_game  text;
  points     smallint[];
  stake      integer := coalesce((select default_skins_stake from league_rules
                                   where league_id = in_league_id), 0);
  copy_groups boolean := coalesce(in_copy_groups, true);
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can start a week.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the week a name.' using errcode = 'check_violation';
  end if;

  select * into prev
    from rounds where league_id = in_league_id
   order by played_on desc, created_at desc limit 1;

  -- A league's first week has nothing to carry forward: it needs a course,
  -- and has no groups to copy.
  if not found then
    if in_course_id is null then
      raise exception 'Pick the course for the league''s first week.'
        using errcode = 'check_violation';
    end if;
    copy_groups := false;
  end if;

  if in_played_on is null or in_played_on <= prev.played_on then
    raise exception 'The new week has to come after %.', prev.played_on
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from seasons where league_id = in_league_id
                and year = extract(year from in_played_on)::integer) then
    raise exception 'The % season is closed. Reopen it on the admin page to add a week.',
      extract(year from in_played_on)::integer
      using errcode = 'check_violation';
  end if;

  course := coalesce(in_course_id, prev.course_id);

  if in_course_id is not null then
    select hole_count into course_max from courses
     where id = in_course_id and club_id = league_club(in_league_id);

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

  week_game := coalesce(in_game, (select default_game from league_rules
                                   where league_id = in_league_id), 'stroke');

  if week_game not in ('stroke', 'stableford', 'scramble', 'best_ball') then
    raise exception 'Pick stroke play, Stableford, best ball or a scramble.'
      using errcode = 'check_violation';
  end if;

  if week_game = 'stableford' then
    points := coalesce((select stableford_points from league_rules
                       where league_id = in_league_id), '{5,4,3,2,1,0}');
  end if;

  -- rounds_get_settings creates this week's round_settings row.
  insert into rounds (league_id, name, played_on, hole_count, start_hole, status, course_id, format,
                      game, stableford_points)
  values (in_league_id, btrim(in_name), in_played_on, holes, start,
          case when copy_groups then 'live' else 'setup' end,
          course, coalesce(prev.format, 'solo'), week_game, points)
  returning id into new_round;

  if copy_groups then
    shift := (in_played_on - prev.played_on) * interval '1 day';

    for tt in
      select id, tee_at, seats
        from tee_times where round_id = prev.id order by tee_at
    loop
      insert into tee_times (round_id, tee_at, starting_hole, seats)
      values (new_round, tt.tee_at + shift, start, tt.seats)
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
                             'course_id', course, 'holes', holes, 'start_hole', start,
                             'game', week_game));

  return new_round;
end;
$function$;

-- owner_close_season: The season of the league asked for.
CREATE OR REPLACE FUNCTION public.owner_close_season(in_league_id uuid, in_year integer, in_champion_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  who text;
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can close a season.'
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

  insert into seasons (league_id, year, closed_at, champion_id, champion_name)
  values (in_league_id, in_year, now(), in_champion_id, who)
  on conflict (league_id, year) do update
     set closed_at = excluded.closed_at,
         champion_id = excluded.champion_id,
         champion_name = excluded.champion_name;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'close', 'season', in_year::text,
          jsonb_build_object('champion', who));
end;
$function$;

-- owner_reopen_season: The season of the league asked for.
CREATE OR REPLACE FUNCTION public.owner_reopen_season(in_league_id uuid, in_year integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can reopen a season.'
      using errcode = 'insufficient_privilege';
  end if;

  delete from seasons where year = in_year and league_id = in_league_id;

  if not found then
    raise exception 'That season isn''t closed.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'reopen', 'season', in_year::text, '{}'::jsonb);
end;
$function$;

-- owner_create_league_event: An event in the league asked for.
CREATE OR REPLACE FUNCTION public.owner_create_league_event(in_league_id uuid, in_name text, in_played_on date, in_course_id uuid DEFAULT NULL::uuid, in_hole_count integer DEFAULT 18, in_start_hole integer DEFAULT 1, in_is_simulator boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  fresh uuid;
  holes integer := coalesce(in_hole_count, 18);
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can create an event.'
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

  insert into events (club_id, league_id,
                      name, played_on, format, format_id, team_size, scope,
                      hole_count, start_hole, is_simulator, course_id, course_name,
                      created_by)
  values (league_club(in_league_id), in_league_id,
          btrim(in_name), in_played_on, 'solo', 'stroke', 1, 'league',
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
$function$;

-- owner_set_league_skins: Skins on or off for the league asked for.
CREATE OR REPLACE FUNCTION public.owner_set_league_skins(in_league_id uuid, in_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can change league settings.'
      using errcode = 'insufficient_privilege';
  end if;

  update league_rules set skins_enabled = in_enabled, updated_at = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          jsonb_build_object('skins_enabled', in_enabled));
end;
$function$;

-- owner_set_league_rules: The rules of the league asked for.
CREATE OR REPLACE FUNCTION public.owner_set_league_rules(in_league_id uuid, in_points integer[], in_completion integer, in_drop_worst integer, in_min_weeks integer, in_ranking text, in_guests_score boolean, in_default_stake integer, in_default_game text DEFAULT NULL::text, in_stableford integer[] DEFAULT NULL::integer[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Left out, a setting keeps what it had rather than snapping to a default.
  table_used integer[] := coalesce(
    in_stableford,
    (select stableford_points::integer[] from league_rules where league_id = in_league_id),
    '{5,4,3,2,1,0}');
  game_used  text := coalesce(
    in_default_game,
    (select default_game from league_rules where league_id = in_league_id),
    'stroke');
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can change the rules.'
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

  if game_used not in ('stroke', 'stableford', 'scramble', 'best_ball') then
    raise exception 'Pick stroke play, Stableford, best ball or a scramble.'
      using errcode = 'check_violation';
  end if;

  perform check_stableford_table(table_used);

  update league_rules
     set points_table        = in_points::smallint[],
         completion_point    = in_completion,
         drop_worst          = in_drop_worst,
         min_weeks           = in_min_weeks,
         ranking             = in_ranking,
         guests_score        = coalesce(in_guests_score, false),
         default_skins_stake = in_default_stake,
         default_game        = game_used,
         stableford_points   = table_used::smallint[],
         updated_at          = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          jsonb_build_object('points', in_points, 'completion', in_completion,
                             'drop_worst', in_drop_worst, 'min_weeks', in_min_weeks,
                             'ranking', in_ranking, 'guests_score', in_guests_score,
                             'default_stake', in_default_stake,
                             'default_game', game_used,
                             'stableford', table_used));
end;
$function$;

-- admin_set_tee_defaults: The first tee and gap for the league asked for.
CREATE OR REPLACE FUNCTION public.admin_set_tee_defaults(in_league_id uuid, in_first_tee time without time zone, in_interval integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can change the tee time defaults.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_first_tee is null then
    raise exception 'Pick the first tee time.' using errcode = 'check_violation';
  end if;

  if in_interval is null or in_interval not between 5 and 30 then
    raise exception 'Tee times go 5 to 30 minutes apart.'
      using errcode = 'check_violation';
  end if;

  update league_rules
     set first_tee_time = in_first_tee,
         tee_interval_minutes = in_interval,
         updated_at = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          jsonb_build_object('first_tee', in_first_tee, 'interval', in_interval));
end;
$function$;

-- admin_set_announcement: The announcement of the league asked for.
CREATE OR REPLACE FUNCTION public.admin_set_announcement(in_league_id uuid, in_text text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  clean text := nullif(btrim(coalesce(in_text, '')), '');
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can post an announcement.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(clean) > 500 then
    raise exception 'Keep it under 500 characters.' using errcode = 'check_violation';
  end if;

  update league_rules
     set announcement = clean,
         announcement_at = case when clean is null then null else now() end,
         updated_at = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), case when clean is null then 'delete' else 'update' end,
          'announcement', in_league_id::text, jsonb_build_object('text', clean));
end;
$function$;

-- owner_set_simulator_weight: The simulator weight feeds every player's
-- handicap, in every club, so it is the platform admin's to set.
CREATE OR REPLACE FUNCTION public.owner_set_simulator_weight(in_weight numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_platform_admin() then
    raise exception 'Only the platform admin can change what a simulator round is worth.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_weight is null or in_weight < 0 or in_weight > 1 then
    raise exception 'A simulator round counts for 0 to 100 per cent.'
      using errcode = 'check_violation';
  end if;

  update league_settings
     set simulator_weight = round(in_weight, 3),
         updated_at = now();

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_settings', 'simulator',
          jsonb_build_object('simulator_weight', round(in_weight, 3)));
end;
$function$;

-- import_course: Into the club asked for. The same course imported by two
-- clubs is two copies, one each, so a club correcting a par never changes
-- another's.
CREATE OR REPLACE FUNCTION public.import_course(payload jsonb, in_club_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare imported_id uuid; hole_json jsonb; tee_json jsonb;
begin
  if auth.uid() is not null and not is_club_admin(in_club_id) then
    raise exception 'Only an admin of this club can import a course.'
      using errcode = 'insufficient_privilege';
  end if;

  insert into courses (club_id, name, hole_count, external_id, latitude, longitude, timezone,
                       location_name, city, state, attribution)
  values (in_club_id, payload ->> 'name', (payload ->> 'hole_count')::smallint,
          payload ->> 'external_id', (payload ->> 'latitude')::double precision,
          (payload ->> 'longitude')::double precision, payload ->> 'timezone',
          payload ->> 'location_name', payload ->> 'city', payload ->> 'state',
          payload ->> 'attribution')
  on conflict (club_id, external_id) do update set
    name = excluded.name, hole_count = excluded.hole_count,
    latitude = excluded.latitude, longitude = excluded.longitude,
    timezone = excluded.timezone, location_name = excluded.location_name,
    city = excluded.city, state = excluded.state, attribution = excluded.attribution
  returning id into imported_id;

  for hole_json in select * from jsonb_array_elements(payload -> 'holes') loop
    insert into course_holes (course_id, hole, par, handicap_index, yardages)
    values (imported_id, (hole_json ->> 'hole')::smallint,
            (hole_json ->> 'par')::smallint,
            (hole_json ->> 'handicap_index')::smallint, hole_json -> 'yardages')
    on conflict (course_id, hole) do update set
      par = excluded.par, handicap_index = excluded.handicap_index,
      yardages = excluded.yardages;
  end loop;

  delete from course_tees where course_tees.course_id = imported_id;

  for tee_json in select * from jsonb_array_elements(payload -> 'tees') loop
    insert into course_tees (course_id, tee_key, tee_name, tee_color, gender,
                             course_rating, slope, par, yardage)
    values (imported_id, tee_json ->> 'tee_key', tee_json ->> 'tee_name',
            tee_json ->> 'tee_color', tee_json ->> 'gender',
            (tee_json ->> 'course_rating')::numeric,
            (tee_json ->> 'slope')::smallint, (tee_json ->> 'par')::smallint,
            (tee_json ->> 'yardage')::integer);
  end loop;

  return imported_id;
end;
$function$;

-- league_season: Its rules are the league's own now.
CREATE OR REPLACE FUNCTION public.league_season(in_league_id uuid, in_year integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  season integer := coalesce(in_year, extract(year from current_date)::integer);
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if not sees_league(in_league_id) then
    raise exception 'You aren''t in this league.' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'year', season,
    'leagueSkins', coalesce((select skins_enabled from league_rules
                              where league_id = in_league_id), true),

    'rules', coalesce((
      select jsonb_build_object(
               'points',          points_table,
               'completionPoint', completion_point,
               'dropWorst',       drop_worst,
               'minWeeks',        min_weeks,
               'ranking',         ranking,
               'guestsScore',     guests_score,
               'defaultGame',     default_game,
               'stableford',      stableford_points)
        from league_rules
       where league_id = in_league_id
    ), '{}'::jsonb),

    'years', coalesce((
      select jsonb_agg(y.year order by y.year desc)
        from (select distinct extract(year from played_on)::integer as year
                from rounds where league_id = in_league_id) as y
    ), '[]'::jsonb),

    'closed', (
      select jsonb_build_object(
               'closedAt',     s.closed_at,
               'championId',   s.champion_id,
               'championName', s.champion_name)
        from seasons s
       where s.year = season and s.league_id = in_league_id
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
       where exists (select 1 from league_members lm
                      where lm.profile_id = p.id and lm.league_id = in_league_id
                        and lm.status in ('active', 'removed'))
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
                   'game',               rd.game,
                   'stablefordPoints',   rd.stableford_points,
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
                                'seats', t.seats,
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
             and rd.league_id = in_league_id
        ) as w
    ), '[]'::jsonb)
  );
end;
$function$;

-- ------------------------------------------------------------ who may call them

/*
  Re-created functions take Supabase's default grants, which include anon.
  Every one of these is for signed-in admins, and checks which club.
*/
do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'owner_league_overview(uuid)',
    'owner_start_new_week(uuid, text, date, boolean, uuid, integer, integer, text)',
    'owner_close_season(uuid, integer, uuid)',
    'owner_reopen_season(uuid, integer)',
    'owner_create_league_event(uuid, text, date, uuid, integer, integer, boolean)',
    'owner_set_league_skins(uuid, boolean)',
    'owner_set_league_rules(uuid, integer[], integer, integer, integer, text, boolean, integer, text, integer[])',
    'admin_set_tee_defaults(uuid, time without time zone, integer)',
    'admin_set_announcement(uuid, text)',
    'import_course(jsonb, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;
