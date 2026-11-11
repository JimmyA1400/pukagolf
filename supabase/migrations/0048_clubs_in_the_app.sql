/*
  The app learns there is more than one club and more than one league.

  Until now the season, the league's events and the charity totals each
  answered for the one league there was (since 0047, the Saturday League by
  name). Each now takes the league or club it is asked about, and checks the
  caller may see it, so a page under /c/<club> asks for that club and the
  league picked there.

  And two lookups the pages need:

    my_clubs()        the clubs the caller belongs to and the leagues they can
                      see in each, for the club and league switchers
    club_public(slug) whether a club exists at an address, with its name, for
                      anyone: a page has to say "no such club" apart from
                      "you aren't a member", and the join page coming next is
                      for people who aren't members yet

  The old signatures are dropped rather than kept beside the new ones: a call
  with no league would otherwise still match them and quietly answer for the
  Saturday League.
*/

drop function if exists league_season(integer);
drop function if exists league_events();
drop function if exists charity_totals();

-- league_season: the season of the league asked for.
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
    -- League rules are still PukaGolf's one row; any other league plays the
    -- defaults the app falls back to, until rules belong to each league.
    'leagueSkins', coalesce((select skins_enabled from league_settings
                              where in_league_id = 'b0000000-0000-4000-8000-000000000001'), true),

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
        from league_settings
       where in_league_id = 'b0000000-0000-4000-8000-000000000001'
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

-- league_events: the events of the league asked for.
CREATE OR REPLACE FUNCTION public.league_events(in_league_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      from events e
     where e.scope = 'league' and e.league_id = in_league_id and sees_league(e.league_id)
  ), '[]'::jsonb);
end;
$function$;

-- charity_totals: the charities of the club asked for.
CREATE OR REPLACE FUNCTION public.charity_totals(in_club_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
           jsonb_agg(t_row.payload order by t_row.position, t_row.name),
           '[]'::jsonb
         )
    from (
      select ch.position,
             ch.name,
             jsonb_build_object(
               'id', ch.id,
               'name', ch.name,
               'description', ch.description,
               'logoUrl', ch.logo_url,
               'website', ch.website,
               'active', ch.active,
               'seasonTotal', coalesce((
                 select sum(t.raised) from tournaments t
                  where t.charity_id = ch.id
                    and extract(year from t.played_on) = extract(year from now())
               ), 0),
               'allTimeTotal', coalesce((
                 select sum(t.raised) from tournaments t
                  where t.charity_id = ch.id
               ), 0),
               'events', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id', t.id,
                            'name', t.name,
                            'playedOn', t.played_on,
                            'raised', t.raised
                          ) order by t.played_on desc
                        )
                   from tournaments t
                  where t.charity_id = ch.id and t.raised > 0
               ), '[]'::jsonb)
             ) as payload
        from charities ch
       where ch.club_id = in_club_id and is_club_member(ch.club_id)
    ) as t_row;
$function$;


-- ------------------------------------------------------------ my clubs

/*
  Every club the caller is an active member of, their role there, and the
  leagues in it they can see, marking the ones they play in. The platform
  admin sees every open club. One call, because every page's navigation needs
  it before it can draw.
*/
create or replace function my_clubs()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(x.club order by x.name), '[]'::jsonb)
    from (
      select cl.name,
             jsonb_build_object(
               'id',     cl.id,
               'slug',   cl.slug,
               'name',   cl.name,
               'status', cl.status,
               'isDemo', cl.is_demo,
               'role',   coalesce(club_role(cl.id),
                                  case when is_platform_admin() then 'admin' end),
               'leagues', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id',    l.id,
                            'slug',  l.slug,
                            'name',  l.name,
                            'plays', exists (
                              select 1 from league_members lm
                               where lm.league_id = l.id
                                 and lm.profile_id = auth.uid()
                                 and lm.status = 'active'))
                          order by l.name)
                   from leagues l
                  where l.club_id = cl.id
                    and l.status = 'active'
                    and sees_league(l.id)
               ), '[]'::jsonb)
             ) as club
        from clubs cl
       where cl.status <> 'closed'
         and (club_role(cl.id) is not null or is_platform_admin())
    ) as x;
$fn$;

-- ------------------------------------------------------------ a club's address

/*
  A club's public face: enough to name it on its own pages and to tell a
  wrong address from a club the visitor isn't in. Nothing about its members,
  leagues or scores. Open to signed-out visitors on purpose.
*/
create or replace function club_public(in_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object('id', id, 'slug', slug, 'name', name,
                            'status', status, 'isDemo', is_demo)
    from clubs
   where slug = lower(btrim(in_slug)) and status <> 'closed';
$fn$;

-- ------------------------------------------------------------ who may call them

/*
  Re-created functions take Supabase's default grants, which include anon.
  Only club_public() is for signed-out visitors.
*/
do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'league_season(uuid, integer)', 'league_events(uuid)',
    'charity_totals(uuid)', 'my_clubs()'
  ] loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

revoke execute on function club_public(text) from public;
grant execute on function club_public(text) to anon, authenticated;
