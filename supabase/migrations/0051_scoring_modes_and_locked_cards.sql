/*
  How a league keeps score, and when a card is done.

  Scoring mode, chosen by each league's admins:

    partner    Partner Scoring: player i keeps player i+1's card, round the
               group, and nobody enters their own. Exactly the rotation the
               app has always had; still the default.
    self       Self Scoring: each player keeps their own card.
    team       Team Card Scoring: anyone in the group keeps every card in the
               group, their own included; one phone can score the four.

  The mode changes who may enter a score (may_score), nothing else: a
  correction is still for an admin, or staff the admin allows, and only an
  admin reassigns scorers.

  Locked cards. A card is locked when the group signs off (sign_off_group:
  anyone in the group, once every card in it is complete), when an admin
  locks it, or when the week is marked final. A locked card can be changed by
  a club admin and nobody else, not even staff who may fix scores: money can
  ride on skins, and a card everyone agreed on shouldn't move without the
  person in charge. Every change to a card is in the audit log, and
  card_history() shows one card's whole story to its club's admins.

  The score log now records the round each change was in, so a card's history
  is complete from here on. Earlier entries are found through the score they
  name, while it still exists.
*/

-- ------------------------------------------------------------ scoring mode

alter table league_rules
  add column scoring_mode text not null default 'partner'
    check (scoring_mode in ('partner', 'self', 'team'));

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
      -- Partner Scoring: the one card you keep, never your own.
      else
        target_player <> auth.uid()
        and exists (select 1
                      from scorer_assignments sa
                      join tee_times tt on tt.id = sa.tee_time_id
                     where tt.round_id = target_round
                       and sa.scorer_player_id = auth.uid()
                       and sa.scored_player_id = target_player)
    end,
    false);
$fn$;

create or replace function league_set_scoring_mode(in_league_id uuid, in_mode text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(league_club(in_league_id));

  if in_mode not in ('partner', 'self', 'team') then
    raise exception 'Pick Partner Scoring, Self Scoring or Team Card Scoring.'
      using errcode = 'check_violation';
  end if;

  update league_rules set scoring_mode = in_mode, updated_at = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          jsonb_build_object('scoring_mode', in_mode));
end;
$fn$;

-- ------------------------------------------------------------ locked cards

create table card_locks (
  round_id  uuid not null references rounds on delete cascade,
  player_id uuid not null references profiles on delete cascade,
  locked_at timestamptz not null default now(),
  locked_by uuid references profiles on delete set null,
  primary key (round_id, player_id)
);

alter table card_locks enable row level security;

-- Seen by whoever can see the week, so the card can say it is signed off.
-- Written only by the functions below.
create policy read_card_locks on card_locks for select to authenticated
  using (sees_league(round_league(round_id)));

-- So a phone shows a card as signed off the moment the group signs it.
alter publication supabase_realtime add table card_locks;

create or replace function card_locked(in_round_id uuid, in_player_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((select status = 'final' from rounds where id = in_round_id), false)
      or exists (select 1 from card_locks where round_id = in_round_id and player_id = in_player_id);
$fn$;

/*
  The group signs its cards: anyone in it, once every card in the group has
  all the week's holes. After this only a club admin changes them.
*/
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

  insert into card_locks (round_id, player_id, locked_by)
  select week.id, ttp.player_id, auth.uid()
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

-- A club admin locks or unlocks one card.
create or replace function admin_set_card_lock(in_round_id uuid, in_player_id uuid, in_locked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(round_club(in_round_id));

  if in_locked then
    insert into card_locks (round_id, player_id, locked_by)
    values (in_round_id, in_player_id, auth.uid())
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

/*
  The score policies, with the lock: a locked card is a club admin's alone.
  Otherwise as before: the person entering is recorded, and may enter it
  under the league's scoring mode or may fix scores in the club.
*/
drop policy if exists scorer_inserts on scores;
drop policy if exists scorer_updates on scores;

create policy scorer_inserts on scores for insert to authenticated
  with check (entered_by = auth.uid()
              and (is_club_admin(round_club(round_id))
                   or (not card_locked(round_id, player_id)
                       and (can_fix_scores(round_club(round_id)) or may_score(round_id, player_id)))));

create policy scorer_updates on scores for update to authenticated
  using (is_club_admin(round_club(round_id))
         or (not card_locked(round_id, player_id)
             and (can_fix_scores(round_club(round_id)) or may_score(round_id, player_id))))
  with check (entered_by = auth.uid()
              and (is_club_admin(round_club(round_id))
                   or (not card_locked(round_id, player_id)
                       and (can_fix_scores(round_club(round_id)) or may_score(round_id, player_id)))));

-- enter_team_score: as before, and refused on a signed-off card.
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

  -- A signed-off card is the club admin's to change, not the group's.
  if not is_club_admin(round_club(in_round_id))
     and exists (select 1 from tee_time_players ttp
                  where ttp.tee_time_id = in_tee_time_id
                    and card_locked(in_round_id, ttp.player_id)) then
    raise exception 'This group''s cards are signed off. Ask a club admin to change them.'
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

-- ------------------------------------------------------------ a card's history

-- The score log names the round from now on, so one card's story can be told.
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
    end);
  return coalesce(new, old);
end;
$fn$;

/*
  Everything that happened to one card, oldest first: each hole entered or
  changed, by whom, and each lock and sign-off. For the club's admins.
*/
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
             'to', (a.detail ->> 'to')::integer
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

-- ------------------------------------------------------------ who may call them

do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'league_set_scoring_mode(uuid, text)', 'sign_off_group(uuid)',
    'admin_set_card_lock(uuid, uuid, boolean)', 'card_history(uuid, uuid)',
    'card_locked(uuid, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;
