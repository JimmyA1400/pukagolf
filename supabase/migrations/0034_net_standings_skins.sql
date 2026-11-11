/*
  Net scores, season standings and the skins bracket.

  The scoring itself happens in the browser (src/lib/net.ts and
  src/lib/standings.ts, both tested) so that the leaderboard, the standings
  and the bracket share one implementation of the rules. The database
  supplies the season in one call and holds the two settings that matter:
  whether skins are played at all, and each player's handicap index.
*/

-- ---------------------------------------------------------- league settings

/*
  League-wide switches. Skins could already be turned off for a single week
  (round_settings.skins_enabled); this turns them off for the whole league, for
  a league that doesn't play them, and hides the pot, the bracket and the
  season skins column everywhere.
*/
create table if not exists league_settings (
  singleton     boolean primary key default true check (singleton),
  skins_enabled boolean not null default true,
  updated_at    timestamptz not null default now()
);

insert into league_settings (singleton) values (true) on conflict (singleton) do nothing;

alter table league_settings enable row level security;

create policy read_league_settings on league_settings for select to authenticated
  using (true);
-- No write policy: changed only through owner_set_league_skins.

create or replace function owner_set_league_skins(in_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can change league settings.'
      using errcode = 'insufficient_privilege';
  end if;

  update league_settings set skins_enabled = in_enabled, updated_at = now();

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_settings', 'skins',
          jsonb_build_object('skins_enabled', in_enabled));
end;
$fn$;

-- ------------------------------------------------------------- handicaps

/*
  Net scoring is only as fair as the index behind it, so the owner can set a
  player's. Same bounds as save_player_details: +10 to 54, stored negative for
  a plus handicap.
*/
create or replace function owner_set_handicap(in_profile_id uuid, in_index numeric)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  who text;
begin
  if not is_owner() then
    raise exception 'Only the league owner can set a handicap.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_index is not null and (in_index < -10 or in_index > 54) then
    raise exception 'A handicap index runs from +10 to 54.'
      using errcode = 'check_violation';
  end if;

  update profiles set handicap_index = round(in_index, 1)
   where id = in_profile_id
  returning full_name into who;

  if who is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'handicap', in_profile_id::text,
          jsonb_build_object('name', who, 'handicap_index', round(in_index, 1)));
end;
$fn$;

-- ----------------------------------------------------------- the season

/*
  Everything needed to score a season, in one call: every week of the year
  with its pars, stroke indexes, rated tees, groups (and the tee each player
  played) and scores, plus the players and the league's skins switch.

  Nothing here is private to anyone signed in — the same rows are readable
  through the tables — so it is simply gathered, not filtered.
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

    'players', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', p.id,
                 'name', p.full_name,
                 'handicapIndex', p.handicap_index,
                 'preferredTee', p.preferred_tee
               ) order by p.full_name)
        from profiles p
    ), '[]'::jsonb),

    'rounds', coalesce((
      select jsonb_agg(w.entry order by w.played_on, w.created_at)
        from (
          select rd.played_on,
                 rd.created_at,
                 jsonb_build_object(
                   'id',           rd.id,
                   'name',         rd.name,
                   'playedOn',     rd.played_on,
                   'status',       rd.status,
                   'holeCount',    rd.hole_count,
                   'skinsEnabled', coalesce(rs.skins_enabled, true),
                   'skinsStake',   coalesce(rs.skins_stake, 0),
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

-- --------------------------------------------------------------- grants

revoke execute on function owner_set_league_skins(boolean) from public, anon;
revoke execute on function owner_set_handicap(uuid, numeric) from public, anon;
revoke execute on function league_season(integer) from public, anon;

grant execute on function owner_set_league_skins(boolean) to authenticated;
grant execute on function owner_set_handicap(uuid, numeric) to authenticated;
grant execute on function league_season(integer) to authenticated;
