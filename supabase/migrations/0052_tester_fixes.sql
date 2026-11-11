/*
  What the Practice Ridge testers found, fixed where the database decides.

  1. A card whose keeper has no login. Under Partner Scoring a player's card
     is kept by somebody else; when that somebody is a name with no login
     behind it (a guest, or a player the pro shop added by hand), nobody could
     ever fill the card in and the group could never sign off. Now the player
     keeps their own card for that week, and still keeps the card they were
     given.

  2. The Groups page listed every golfer on the platform under "Not in a
     group". It lists this league's own members now. Two other admin
     functions read profiles with no club in mind: the "already uses that
     number" check when an admin edits a player no longer names a golfer from
     another club, and closing a season takes a champion from the league only.

  3. Standings: each league chooses whether a week still being played counts
     (shown as provisional) or only final weeks do. Final only, unless the pro
     shop says otherwise.

  4. A signed-off card, or any card in a closed season, is changed only by a
     club admin, only through admin_fix_signed_score(), and only with a reason.
     The reason is kept with the change, shown in the card's history, and, for
     a closed season, in the season's own audit trail.

  5. An admin's or staff member's own card follows the league's scoring mode
     like anyone else's. They still fix other people's cards.

  Additive: one new column with a default, new functions, and replacements
  for functions and policies. No score, player or league row is touched.
*/

-- ------------------------------------------------------------ who has a login

-- A profile with an account behind it. Guests and hand-added players have none.
create or replace function has_login(in_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from auth.users where id = in_profile_id);
$fn$;

/*
  The players in one week with no login, so the pad can say why somebody is
  keeping their own card. Only for a week the caller can see.
*/
create or replace function round_players_without_login(in_round_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(array_agg(ttp.player_id order by ttp.player_id), '{}'::uuid[])
    from tee_time_players ttp
   where ttp.round_id = in_round_id
     and sees_league(round_league(in_round_id))
     and not has_login(ttp.player_id);
$fn$;

/*
  As in 0051, with one addition to Partner Scoring: when the person keeping
  your card has no login, you keep your own card that week.
*/
create or replace function may_score(target_round uuid, target_player uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    case (select scoring_mode from league_rules where league_id = round_league(target_round))
      -- Self Scoring: your own card, in a week you are playing.
      when 'self' then
        target_player = auth.uid()
        and exists (select 1 from tee_time_players
                     where round_id = target_round and player_id = auth.uid())
      -- Team Card Scoring: any card in your own group.
      when 'team' then
        exists (select 1
                  from tee_time_players me
                  join tee_time_players them on them.tee_time_id = me.tee_time_id
                 where me.round_id = target_round
                   and me.player_id = auth.uid()
                   and them.player_id = target_player)
      -- Partner Scoring: the one card you keep, never your own...
      else
        (target_player <> auth.uid()
         and exists (select 1
                       from scorer_assignments sa
                       join tee_times tt on tt.id = sa.tee_time_id
                      where tt.round_id = target_round
                        and sa.scorer_player_id = auth.uid()
                        and sa.scored_player_id = target_player))
        -- ...unless whoever keeps yours can't sign in to do it.
        or (target_player = auth.uid()
            and exists (select 1
                          from scorer_assignments sa
                          join tee_times tt on tt.id = sa.tee_time_id
                         where tt.round_id = target_round
                           and sa.scored_player_id = auth.uid()
                           and not has_login(sa.scorer_player_id)))
    end,
    false);
$fn$;

-- ------------------------------------------------------------ closed seasons

-- The week belongs to a season its league has closed.
create or replace function round_season_closed(in_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1
                   from rounds r
                   join seasons s on s.league_id = r.league_id
                                 and s.year = extract(year from r.played_on)::integer
                  where r.id = in_round_id);
$fn$;

-- Signed off, locked, in a final week, or in a closed season: a reason is needed.
create or replace function score_needs_reason(in_round_id uuid, in_player_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select card_locked(in_round_id, in_player_id) or round_season_closed(in_round_id);
$fn$;

/*
  The score policies. Nobody writes straight to a card that needs a reason,
  not even a club admin: that goes through admin_fix_signed_score(). Fixing
  scores (an admin, or staff the admin allows) is for other people's cards;
  your own is kept the league's way, by may_score(), like anybody's.
*/
drop policy if exists scorer_inserts on scores;
drop policy if exists scorer_updates on scores;
drop policy if exists admin_deletes_scores on scores;

create policy scorer_inserts on scores for insert to authenticated
  with check (entered_by = auth.uid()
              and not score_needs_reason(round_id, player_id)
              and ((player_id <> auth.uid() and can_fix_scores(round_club(round_id)))
                   or may_score(round_id, player_id)));

create policy scorer_updates on scores for update to authenticated
  using (not score_needs_reason(round_id, player_id)
         and ((player_id <> auth.uid() and can_fix_scores(round_club(round_id)))
              or may_score(round_id, player_id)))
  with check (entered_by = auth.uid()
              and not score_needs_reason(round_id, player_id)
              and ((player_id <> auth.uid() and can_fix_scores(round_club(round_id)))
                   or may_score(round_id, player_id)));

create policy admin_deletes_scores on scores for delete to authenticated
  using (is_club_admin(round_club(round_id))
         and player_id <> auth.uid()
         and not score_needs_reason(round_id, player_id));

/*
  A club admin changes a signed-off card, or a card in a closed season, and
  says why. One hole at a time, never their own card.
*/
create or replace function admin_fix_signed_score(
  in_round_id uuid, in_player_id uuid, in_hole integer, in_strokes integer, in_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me         uuid := auth.uid();
  why        text := btrim(coalesce(in_reason, ''));
  week       rounds%rowtype;
  was_locked boolean;
  was_closed boolean;
  before     smallint;
  last       integer;
begin
  perform assert_club_admin(round_club(in_round_id));

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if in_player_id = me then
    raise exception 'Your own card is kept the league''s way, like anyone''s. Another club admin can change it.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from tee_time_players
                  where round_id = in_round_id and player_id = in_player_id)
     and not exists (select 1 from scores
                      where round_id = in_round_id and player_id = in_player_id) then
    raise exception 'That player isn''t in this week.' using errcode = 'check_violation';
  end if;

  was_locked := card_locked(in_round_id, in_player_id);
  was_closed := round_season_closed(in_round_id);

  if not (was_locked or was_closed) then
    raise exception 'This card isn''t signed off, so it can be changed on the card as usual.'
      using errcode = 'check_violation';
  end if;

  if length(why) < 3 then
    raise exception 'Say why the card is being changed.' using errcode = 'check_violation';
  end if;

  if length(why) > 300 then
    raise exception 'Keep the reason under 300 characters.' using errcode = 'check_violation';
  end if;

  if in_strokes is null or in_strokes not between 1 and 20 then
    raise exception 'A hole is 1 to 20 strokes.' using errcode = 'check_violation';
  end if;

  last := week.start_hole + week.hole_count - 1;

  if in_hole is null or in_hole < week.start_hole or in_hole > last then
    raise exception 'This week is holes % to %.', week.start_hole, last
      using errcode = 'check_violation';
  end if;

  select strokes into before from scores
   where round_id = in_round_id and player_id = in_player_id and hole = in_hole;

  -- Read by log_score_change(), so the reason is kept with the change itself.
  perform set_config('pukagolf.change_reason', why, true);
  perform set_config('pukagolf.card_was',
                     case when was_locked then 'signed_off' else 'season_closed' end, true);

  insert into scores (round_id, player_id, hole, strokes, entered_by)
  values (in_round_id, in_player_id, in_hole, in_strokes, me)
  on conflict (round_id, player_id, hole)
    do update set strokes    = excluded.strokes,
                  entered_by = excluded.entered_by,
                  updated_at = now();

  perform set_config('pukagolf.change_reason', '', true);
  perform set_config('pukagolf.card_was', '', true);

  -- The closed season's own trail, alongside close and reopen.
  if was_closed then
    insert into audit_log (actor_id, action, entity, entity_id, detail)
    values (me, 'score_fix', 'season', extract(year from week.played_on)::integer::text,
            jsonb_build_object('league_id', week.league_id, 'round_id', in_round_id,
                               'player_id', in_player_id, 'hole', in_hole,
                               'from', before, 'to', in_strokes, 'reason', why));
  end if;
end;
$fn$;

-- As in 0051, keeping the reason and the card's state when there is one.
create or replace function log_score_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), lower(TG_OP), 'score', coalesce(new.id, old.id)::text,
    case TG_OP
      when 'INSERT' then jsonb_build_object('round_id', new.round_id, 'player_id', new.player_id,
                                            'hole', new.hole, 'strokes', new.strokes)
      when 'UPDATE' then jsonb_build_object('round_id', new.round_id, 'player_id', new.player_id,
                                            'hole', new.hole, 'from', old.strokes, 'to', new.strokes)
      else jsonb_build_object('round_id', old.round_id, 'player_id', old.player_id,
                              'hole', old.hole, 'strokes', old.strokes)
    end
    || jsonb_strip_nulls(jsonb_build_object(
         'reason',  nullif(current_setting('pukagolf.change_reason', true), ''),
         'cardWas', nullif(current_setting('pukagolf.card_was', true), ''))));
  return coalesce(new, old);
end;
$fn$;

-- As in 0051, with the reason and the card's state on each line.
create or replace function card_history(in_round_id uuid, in_player_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(round_club(in_round_id));

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'at', a.at,
             'action', a.action,
             'entity', a.entity,
             'by', coalesce(pr.full_name, a.actor_label, 'The system'),
             'hole', (a.detail ->> 'hole')::integer,
             'strokes', (a.detail ->> 'strokes')::integer,
             'from', (a.detail ->> 'from')::integer,
             'to', (a.detail ->> 'to')::integer,
             'reason', a.detail ->> 'reason',
             'cardWas', a.detail ->> 'cardWas'
           ) order by a.at, a.id)
      from audit_log a
      left join profiles pr on pr.id = a.actor_id
     where (a.entity = 'score'
            and ((a.detail ->> 'round_id' = in_round_id::text
                  and a.detail ->> 'player_id' = in_player_id::text)
                 or a.entity_id in (select s.id::text from scores s
                                     where s.round_id = in_round_id
                                       and s.player_id = in_player_id)))
        or (a.entity = 'card'
            and (a.entity_id = in_round_id::text || ':' || in_player_id::text
                 or (a.action = 'sign_off'
                     and a.detail ->> 'round_id' = in_round_id::text
                     and exists (select 1 from tee_time_players ttp
                                  where ttp.tee_time_id::text = a.entity_id
                                    and ttp.player_id = in_player_id))))
  ), '[]'::jsonb);
end;
$fn$;

-- enter_team_score: as in 0051, but a card needing a reason stops everyone.
CREATE OR REPLACE FUNCTION public.enter_team_score(in_round_id uuid, in_tee_time_id uuid, in_hole integer, in_strokes integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  week  rounds%rowtype;
  me    uuid := auth.uid();
  last  integer;
  wrote integer;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if week.game <> 'scramble' then
    raise exception 'This week isn''t a scramble, so every player posts their own card.'
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from tee_times
                  where id = in_tee_time_id and round_id = in_round_id) then
    raise exception 'That group isn''t in this week.' using errcode = 'check_violation';
  end if;

  if not can_fix_scores(round_club(in_round_id))
     and not exists (select 1 from tee_time_players
                      where tee_time_id = in_tee_time_id and player_id = me) then
    raise exception 'You can only post a score for your own group.'
      using errcode = 'insufficient_privilege';
  end if;

  -- A signed-off card is changed one card at a time, by a club admin, with a reason.
  if exists (select 1 from tee_time_players ttp
              where ttp.tee_time_id = in_tee_time_id
                and score_needs_reason(in_round_id, ttp.player_id)) then
    raise exception 'This group''s cards are signed off. A club admin can change them, with a reason.'
      using errcode = 'check_violation';
  end if;

  if in_strokes is null or in_strokes not between 1 and 20 then
    raise exception 'A hole is 1 to 20 strokes.' using errcode = 'check_violation';
  end if;

  last := week.start_hole + week.hole_count - 1;

  if in_hole is null or in_hole < week.start_hole or in_hole > last then
    raise exception 'This week is holes % to %.', week.start_hole, last
      using errcode = 'check_violation';
  end if;

  insert into scores (round_id, player_id, hole, strokes, entered_by)
  select in_round_id, ttp.player_id, in_hole, in_strokes, me
    from tee_time_players ttp
   where ttp.tee_time_id = in_tee_time_id
  on conflict (round_id, player_id, hole)
    do update set strokes    = excluded.strokes,
                  entered_by = excluded.entered_by,
                  updated_at = now();

  get diagnostics wrote = row_count;

  if wrote = 0 then
    raise exception 'That group has nobody in it yet.' using errcode = 'check_violation';
  end if;

  return wrote;
end;
$function$;

-- ------------------------------------------------------------ standings

/*
  Whether a week still being played counts in the standings:
    final  only weeks marked final count; no leader until then (the default)
    live   a live week counts too, shown as provisional
  A week still being set up never counts.
*/
alter table league_rules
  add column if not exists standings_count text not null default 'final'
    check (standings_count in ('final', 'live'));

create or replace function league_set_standings_count(in_league_id uuid, in_count text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(league_club(in_league_id));

  if in_count not in ('final', 'live') then
    raise exception 'Pick whether a week counts while it''s played, or only once it''s final.'
      using errcode = 'check_violation';
  end if;

  update league_rules set standings_count = in_count, updated_at = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          jsonb_build_object('standings_count', in_count));
end;
$fn$;

-- ------------------------------------------------------------ the Groups page

-- admin_week_groups: as in 0047, with "Not in a group" and the RSVP count
-- limited to the league's own members.
CREATE OR REPLACE FUNCTION public.admin_week_groups(in_round_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  week rounds%rowtype;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'round', jsonb_build_object(
      'id',         week.id,
      'name',       week.name,
      'playedOn',   week.played_on,
      'status',     week.status,
      'rsvpLockAt', week.rsvp_lock_at,
      'game',       week.game,
      'hasScores',  exists (select 1 from scores where round_id = week.id)
    ),

    'groups', coalesce((
      select jsonb_agg(g.entry order by g.tee_at, g.id)
        from (
          select t.tee_at,
                 t.id,
                 jsonb_build_object(
                   'id',     t.id,
                   'teeAt',  t.tee_at,
                   'seats',  t.seats,
                   'players', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',       ttp.player_id,
                                'name',     p.full_name,
                                'position', ttp.position,
                                'isGuest',  p.is_guest,
                                -- Who keeps this player's card, so the ring is visible.
                                'keptBy',   (
                                  select k.full_name
                                    from scorer_assignments sa
                                    join profiles k on k.id = sa.scorer_player_id
                                   where sa.tee_time_id = t.id
                                     and sa.scored_player_id = ttp.player_id
                                )
                              ) order by ttp.position
                            )
                       from tee_time_players ttp
                       join profiles p on p.id = ttp.player_id
                      where ttp.tee_time_id = t.id
                   ), '[]'::jsonb)
                 ) as entry
            from tee_times t
           where t.round_id = week.id
        ) as g
    ), '[]'::jsonb),

    -- The league's members not in a group this week, with their answer; guests last.
    'others', coalesce((
      select jsonb_agg(o.entry order by o.rank, o.name)
        from (
          select p.full_name as name,
                 case when p.is_guest then 4
                      else case r.status when 'in' then 0 when 'undecided' then 2
                                         when 'out' then 3 else 1 end
                 end as rank,
                 jsonb_build_object(
                   'id',               p.id,
                   'name',             p.full_name,
                   'rsvp',             r.status,
                   'preferredTeeTime', p.preferred_tee_time,
                   'isGuest',          p.is_guest
                 ) as entry
            from profiles p
            join league_members lm on lm.profile_id = p.id
                                  and lm.league_id = week.league_id
                                  and lm.status = 'active'
            left join round_rsvps r on r.round_id = week.id and r.player_id = p.id
           where not exists (
             select 1 from tee_time_players ttp
              where ttp.round_id = week.id and ttp.player_id = p.id
           )
        ) as o
    ), '[]'::jsonb),

    'rsvp', jsonb_build_object(
      'in',        (select count(*) from round_rsvps where round_id = week.id and status = 'in'),
      'out',       (select count(*) from round_rsvps where round_id = week.id and status = 'out'),
      'undecided', (select count(*) from round_rsvps where round_id = week.id and status = 'undecided'),
      'noAnswer',  (select count(*) from profiles p
                      join league_members lm on lm.profile_id = p.id
                                            and lm.league_id = week.league_id
                                            and lm.status = 'active'
                     where not p.is_guest
                       and not exists (select 1 from round_rsvps r
                                        where r.round_id = week.id and r.player_id = p.id))
    )
  );
end;
$function$;

-- owner_update_player: as before, but a number already in use names its
-- holder only when the admin shares a club with them.
CREATE OR REPLACE FUNCTION public.owner_update_player(in_profile_id uuid, in_full_name text, in_phone text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  clean     text := btrim(coalesce(in_full_name, ''));
  wanted    text := nullif(btrim(coalesce(in_phone, '')), '');
  holder    text;
  holder_id uuid;
  before    profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Only the league owner can edit a player.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from club_members m
                  where m.profile_id = in_profile_id and is_club_admin(m.club_id)) then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  if not is_platform_admin()
     and exists (select 1 from club_members m
                  where m.profile_id = in_profile_id
                    and m.status in ('active', 'requested')
                    and not is_club_admin(m.club_id)) then
    raise exception 'This player is also in another club, so only the PukaGolf owner can change their name or number.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into before from profiles where id = in_profile_id;

  if before.id is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  if length(clean) not between 2 and 80 then
    raise exception 'Enter a first and last name.' using errcode = 'check_violation';
  end if;

  if wanted is not null and wanted !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'Enter a 10-digit US mobile number.' using errcode = 'check_violation';
  end if;

  if wanted is not null and wanted is distinct from before.phone then
    select p.id, p.full_name into holder_id, holder
      from profiles p
     where p.id <> in_profile_id
       and (p.phone = wanted
            or exists (select 1 from auth.users u
                        where u.id = p.id and u.phone = ltrim(wanted, '+')))
     limit 1;

    if holder_id is not null then
      if is_platform_admin() or shares_club(holder_id) then
        raise exception '% already uses that number.', holder
          using errcode = 'unique_violation';
      end if;
      raise exception 'Another golfer already uses that number.'
        using errcode = 'unique_violation';
    end if;

    if exists (select 1 from auth.users where id = in_profile_id) then
      update auth.users set phone = ltrim(wanted, '+') where id = in_profile_id;
    end if;

    update profiles set phone = wanted where id = in_profile_id;
  end if;

  update profiles set full_name = clean where id = in_profile_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'player', in_profile_id::text,
          jsonb_build_object('from', jsonb_build_object('name', before.full_name, 'phone', before.phone),
                             'to', jsonb_build_object('name', clean,
                                                      'phone', coalesce(wanted, before.phone))));
end;
$function$;

-- owner_close_season: as in 0050, with the champion one of the league's own
-- players (or a former one), never a name from somewhere else.
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
    select p.full_name into who
      from profiles p
      join league_members lm on lm.profile_id = p.id
                            and lm.league_id = in_league_id
                            and lm.status in ('active', 'removed')
     where p.id = in_champion_id;

    if who is null then
      raise exception 'The champion has to be one of the league''s players.'
        using errcode = 'no_data_found';
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

-- ------------------------------------------------------------ who may call them

do $grants$
declare
  fn text;
begin
  -- Used inside other functions only.
  foreach fn in array array['has_login(uuid)', 'round_season_closed(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
  end loop;

  foreach fn in array array[
    -- The score policies call it as the signed-in player.
    'score_needs_reason(uuid, uuid)',
    'round_players_without_login(uuid)',
    'admin_fix_signed_score(uuid, uuid, integer, integer, text)',
    'league_set_standings_count(uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;
