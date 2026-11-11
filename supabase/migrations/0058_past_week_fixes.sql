/*
  From the testers' sixth run.

  1. One card in a final week can be put right on its own. Changing a hole
     there already took a reason (admin_fix_signed_score); taking back a
     group's sign-off didn't work at all, so a signed card in a past week
     could only be freed by clearing the whole week. admin_take_back_sign_off
     now takes a reason, and needs one when the week is final. A closed
     season still has to be reopened first. The standings are worked out from
     the scores each time they're shown, so a fixed card's week is scored
     again on its own.

  2. A league can turn off the double-par cap on the scoring pad. The pad
     stops a hole at double par, the league's pick-up rule; a league that
     plays every ball out sets double_par_cap off and the pad goes to 20,
     the most the database takes. On by default, as now.

  3. Saving the rules logs only what changed, and a scoring mode change says
     what it changed from. One "Save rules" used to write a line for the
     mode and the standings setting every time, changed or not, and only
     "changed the rules" could be said about them.

  Additive: one column with a default, one new function, replaced
  functions. No score, player or league row is changed.
*/

-- ------------------------------------------------------------ a sign-off taken back in a final week

-- As in 0057, with a reason, needed when the week is final. The two-argument
-- version goes, so a call naming two arguments can't match both.
drop function if exists admin_take_back_sign_off(uuid, uuid);

create or replace function admin_take_back_sign_off(
  in_round_id uuid, in_player_id uuid, in_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  tee      uuid;
  freed    integer;
  is_final boolean;
  why      text := btrim(coalesce(in_reason, ''));
begin
  perform assert_club_admin(round_club(in_round_id));

  select status = 'final' into is_final from rounds where id = in_round_id;

  if is_final is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if round_season_closed(in_round_id) then
    raise exception 'The season is closed, so every card stays locked. Reopen it on the admin page first.'
      using errcode = 'check_violation';
  end if;

  if is_final and why = '' then
    raise exception 'The week is final. Say why its sign-off is being taken back: the reason is kept with the change.'
      using errcode = 'check_violation';
  end if;

  if length(why) > 300 then
    raise exception 'Keep the reason under 300 characters.' using errcode = 'check_violation';
  end if;

  select tee_time_id into tee
    from tee_time_players where round_id = in_round_id and player_id = in_player_id;

  delete from card_locks cl
   where cl.round_id = in_round_id
     and cl.how = 'signed'
     and (cl.player_id = in_player_id
          or cl.player_id in (select player_id from tee_time_players where tee_time_id = tee));

  get diagnostics freed = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'take_back', 'card', coalesce(tee::text, in_round_id::text || ':' || in_player_id::text),
          jsonb_build_object('round_id', in_round_id, 'player_id', in_player_id, 'cards', freed)
          || jsonb_strip_nulls(jsonb_build_object(
               'reason', nullif(why, ''),
               'week_final', case when is_final then true end)));

  return freed;
end;
$fn$;

revoke execute on function admin_take_back_sign_off(uuid, uuid, text) from public, anon;
grant execute on function admin_take_back_sign_off(uuid, uuid, text) to authenticated;

-- ------------------------------------------------------------ the double-par cap

alter table league_rules add column if not exists double_par_cap boolean not null default true;

comment on column league_rules.double_par_cap is
  'The scoring pad stops a hole at double par, the pick-up rule. Off: up to 20, the most a hole takes.';

create or replace function league_set_double_par_cap(in_league_id uuid, in_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  was boolean;
begin
  perform assert_club_admin(league_club(in_league_id));

  if in_on is null then
    raise exception 'Pick whether a hole stops at double par.' using errcode = 'check_violation';
  end if;

  select double_par_cap into was from league_rules where league_id = in_league_id;

  if was is not distinct from in_on then
    return;
  end if;

  update league_rules set double_par_cap = in_on, updated_at = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          jsonb_build_object('double_par_cap', in_on));
end;
$fn$;

revoke execute on function league_set_double_par_cap(uuid, boolean) from public, anon;
grant execute on function league_set_double_par_cap(uuid, boolean) to authenticated;

-- ------------------------------------------------------------ rules saves say what changed

-- As in 0051, logged only when the mode changes, with what it was.
create or replace function league_set_scoring_mode(in_league_id uuid, in_mode text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  was text;
begin
  perform assert_club_admin(league_club(in_league_id));

  if in_mode not in ('partner', 'self', 'team') then
    raise exception 'Pick Partner Scoring, Self Scoring or Team Card Scoring.'
      using errcode = 'check_violation';
  end if;

  select scoring_mode into was from league_rules where league_id = in_league_id;

  if was is not distinct from in_mode then
    return;
  end if;

  update league_rules set scoring_mode = in_mode, updated_at = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          jsonb_build_object('scoring_mode', in_mode, 'from', was));
end;
$fn$;

-- As in 0052, logged only when it changes.
create or replace function league_set_standings_count(in_league_id uuid, in_count text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  was text;
begin
  perform assert_club_admin(league_club(in_league_id));

  if in_count not in ('final', 'live') then
    raise exception 'Pick whether a week counts while it''s played, or only once it''s final.'
      using errcode = 'check_violation';
  end if;

  select standings_count into was from league_rules where league_id = in_league_id;

  if was is not distinct from in_count then
    return;
  end if;

  update league_rules set standings_count = in_count, updated_at = now()
   where league_id = in_league_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          jsonb_build_object('standings_count', in_count, 'from', was));
end;
$fn$;
