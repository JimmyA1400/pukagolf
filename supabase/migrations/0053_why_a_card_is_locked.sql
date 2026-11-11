/*
  Why a card is locked, said plainly. From the testers' second run.

  A card can't be changed (except by a club admin, with a reason) for any of
  four reasons, and they mean different things to the players on it:

    signed_off     the group signed its cards (sign_off_group)
    locked         a club admin locked the card
    week_final     the week was marked final
    season_closed  the week's season was closed

  card_locks now records which of the first two it was, and a change made
  with a reason records every reason that applied, so the card's history
  never says "after the card was signed off" when nobody signed it.

  Also: a club admin can see the weeks whose cleared scores can still be put
  back. Putting them back already worked for them; listing them was the
  league owner's alone, so the admin page got a refusal on every load.

  Additive: one column with a default, filled in from the audit log for locks
  made so far; replaced functions. No score, player or league row is touched.
*/

-- ------------------------------------------------------------ how a card was locked

alter table card_locks
  add column if not exists how text not null default 'signed'
    check (how in ('signed', 'admin'));

-- Locks an admin made so far, from the log: a lock entry for the card, with
-- no sign-off of its group in the same week after it.
update card_locks cl
   set how = 'admin'
 where exists (select 1 from audit_log a
                where a.entity = 'card' and a.action = 'lock'
                  and a.entity_id = cl.round_id::text || ':' || cl.player_id::text)
   and not exists (select 1 from audit_log a
                    join tee_time_players ttp on ttp.tee_time_id::text = a.entity_id
                   where a.entity = 'card' and a.action = 'sign_off'
                     and a.detail ->> 'round_id' = cl.round_id::text
                     and ttp.player_id = cl.player_id);

-- Every reason that applies to one card now, in the order a player would
-- want them said: what happened to the card itself first.
create or replace function card_lock_reasons(in_round_id uuid, in_player_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $fn$
  select array_remove(array[
    (select case how when 'signed' then 'signed_off' else 'locked' end
       from card_locks where round_id = in_round_id and player_id = in_player_id),
    case when (select status from rounds where id = in_round_id) = 'final' then 'week_final' end,
    case when round_season_closed(in_round_id) then 'season_closed' end
  ], null);
$fn$;

-- sign_off_group: as in 0051, recording that the group signed.
create or replace function sign_off_group(in_tee_time_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  week   rounds%rowtype;
  short  text;
  signed integer;
begin
  select r.* into week from rounds r join tee_times t on t.round_id = r.id
   where t.id = in_tee_time_id;

  if week.id is null then
    raise exception 'No such group.' using errcode = 'no_data_found';
  end if;

  if not exists (select 1 from tee_time_players
                  where tee_time_id = in_tee_time_id and player_id = auth.uid())
     and not is_club_admin(league_club(week.league_id)) then
    raise exception 'Only somebody in the group can sign its cards.'
      using errcode = 'insufficient_privilege';
  end if;

  select string_agg(pr.full_name, ', ')
    into short
    from tee_time_players ttp
    join profiles pr on pr.id = ttp.player_id
   where ttp.tee_time_id = in_tee_time_id
     and (select count(*) from scores s
           where s.round_id = week.id and s.player_id = ttp.player_id) < week.hole_count;

  if short is not null then
    raise exception 'Not every card is finished yet: %.', short using errcode = 'check_violation';
  end if;

  insert into card_locks (round_id, player_id, locked_by, how)
  select week.id, ttp.player_id, auth.uid(), 'signed'
    from tee_time_players ttp
   where ttp.tee_time_id = in_tee_time_id
  on conflict do nothing;

  get diagnostics signed = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'sign_off', 'card', in_tee_time_id::text,
          jsonb_build_object('round_id', week.id, 'cards', signed));

  return signed;
end;
$fn$;

-- admin_set_card_lock: as in 0051, recording that an admin locked it.
create or replace function admin_set_card_lock(in_round_id uuid, in_player_id uuid, in_locked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(round_club(in_round_id));

  if in_locked then
    insert into card_locks (round_id, player_id, locked_by, how)
    values (in_round_id, in_player_id, auth.uid(), 'admin')
    on conflict do nothing;
  else
    delete from card_locks where round_id = in_round_id and player_id = in_player_id;
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), case when in_locked then 'lock' else 'unlock' end, 'card',
          in_round_id::text || ':' || in_player_id::text,
          jsonb_build_object('round_id', in_round_id, 'player_id', in_player_id));
end;
$fn$;

-- admin_fix_signed_score: as in 0052, keeping every reason the card was locked.
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
  reasons    text[];
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

  reasons := card_lock_reasons(in_round_id, in_player_id);
  was_closed := 'season_closed' = any(reasons);

  if cardinality(reasons) = 0 then
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

  -- Read by log_score_change(): the reason, and every reason it was locked.
  perform set_config('pukagolf.change_reason', why, true);
  perform set_config('pukagolf.card_was', array_to_string(reasons, ','), true);

  insert into scores (round_id, player_id, hole, strokes, entered_by)
  values (in_round_id, in_player_id, in_hole, in_strokes, me)
  on conflict (round_id, player_id, hole)
    do update set strokes    = excluded.strokes,
                  entered_by = excluded.entered_by,
                  updated_at = now();

  perform set_config('pukagolf.change_reason', '', true);
  perform set_config('pukagolf.card_was', '', true);

  if was_closed then
    insert into audit_log (actor_id, action, entity, entity_id, detail)
    values (me, 'score_fix', 'season', extract(year from week.played_on)::integer::text,
            jsonb_build_object('league_id', week.league_id, 'round_id', in_round_id,
                               'player_id', in_player_id, 'hole', in_hole,
                               'from', before, 'to', in_strokes, 'reason', why));
  end if;
end;
$fn$;

-- ------------------------------------------------------------ cleared scores

-- owner_restorable_scores: as in 0047, for anyone who runs a club; the rows
-- were already limited to weeks in clubs the caller runs.
CREATE OR REPLACE FUNCTION public.owner_restorable_scores()
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
    select jsonb_agg(jsonb_build_object(
             'roundId',   l.round_id,
             'count',     l.n,
             'clearedAt', l.cleared_at))
      from (
        select distinct on (c.round_id) c.round_id, c.batch, c.cleared_at,
               count(*) over (partition by c.batch) as n
          from cleared_scores c
         where c.cleared_at >= now() - interval '7 days'
           and is_club_admin(round_club(c.round_id))
         order by c.round_id, c.cleared_at desc
      ) as l
     where not exists (select 1 from scores s where s.round_id = l.round_id)
  ), '[]'::jsonb);
end;
$function$;

-- ------------------------------------------------------------ who may call them

-- Used inside admin_fix_signed_score() only; the page reads card_locks itself.
revoke execute on function card_lock_reasons(uuid, uuid) from public, anon, authenticated;
