-- Finishing a round, and finishing an event.
--
-- A round only counts toward a handicap once it is final, so this is the moment
-- the scoring record changes. It refuses while cards are incomplete and names
-- who is missing, because "cannot complete" without a reason is useless on a
-- clubhouse phone.

alter table events
  -- Null while play is live. Set once the organiser closes it out.
  add column completed_at timestamptz;

/** Who still owes holes on a league round, and how many. */
create or replace function round_completion(in_round_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $fn$
  select jsonb_build_object(
    'holeCount', (select hole_count from rounds where id = in_round_id),
    'players', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'playerId', ttp.player_id,
                 'name', pr.full_name,
                 'posted', (
                   select count(*) from scores s
                    where s.round_id = in_round_id
                      and s.player_id = ttp.player_id
                 )
               ) order by pr.full_name
             )
        from tee_time_players ttp
        join profiles pr on pr.id = ttp.player_id
       where ttp.round_id = in_round_id
    ), '[]'::jsonb)
  );
$fn$;

grant execute on function round_completion(uuid) to authenticated;
revoke execute on function round_completion(uuid) from public;

/*
  Mark a round final.

  Refuses while any player is short of a full card. `force` exists because a
  player can walk in after nine, and the admin then needs a way to close the
  round out — but it has to be chosen, not the default.
*/
create or replace function complete_round(
  in_round_id uuid,
  force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  holes    smallint;
  short    text;
begin
  if not is_admin() then
    raise exception 'Only an admin can complete a round.'
      using errcode = 'insufficient_privilege';
  end if;

  select hole_count into holes from rounds where id = in_round_id;
  if holes is null then
    raise exception 'No such round.' using errcode = 'no_data_found';
  end if;

  if not force then
    select string_agg(pr.full_name || ' (' || posted.n || ' of ' || holes || ')', ', ')
      into short
      from tee_time_players ttp
      join profiles pr on pr.id = ttp.player_id
      join lateral (
        select count(*) as n from scores s
         where s.round_id = in_round_id and s.player_id = ttp.player_id
      ) posted on true
     where ttp.round_id = in_round_id
       and posted.n < holes;

    if short is not null then
      raise exception 'Still missing holes: %.', short
        using errcode = 'check_violation';
    end if;
  end if;

  update rounds set status = 'final' where id = in_round_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('status', 'final', 'forced', force));

  return jsonb_build_object('round_id', in_round_id, 'status', 'final');
end;
$fn$;

revoke execute on function complete_round(uuid, boolean) from public;
grant execute on function complete_round(uuid, boolean) to authenticated;

/*
  Mark an event finished, from the event admin page.

  Same rule, but a team's card is what must be complete: a scramble posts one
  score per hole for the whole team, so counting player cards would never
  reach the hole count.
*/
create or replace function event_admin_complete(
  admin_token text,
  force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := event_for_admin_token(admin_token);
  holes  smallint;
  short  text;
begin
  if target is null then
    raise exception 'Not unlocked for this event.'
      using errcode = 'insufficient_privilege';
  end if;

  select hole_count into holes from events where id = target;

  if not force then
    select string_agg(t.label, ', ') into short
      from (
        select coalesce(et.name, 'Team') ||
               ' (' || count(distinct es.hole) || ' of ' || holes || ')' as label
          from event_teams et
          left join event_scores es on es.team_id = et.id
         where et.event_id = target
         group by et.id, et.name
        having count(distinct es.hole) < holes
      ) t;

    if short is not null then
      raise exception 'Still missing holes: %.', short
        using errcode = 'check_violation';
    end if;
  end if;

  update events set completed_at = now() where id = target;

  insert into audit_log (actor_label, action, entity, entity_id, detail)
  values ('event admin', 'update', 'event', target::text,
          jsonb_build_object('completed', true, 'forced', force));

  return event_state((select share_token from events where id = target));
end;
$fn$;

revoke execute on function event_admin_complete(text, boolean) from public;
grant execute on function event_admin_complete(text, boolean) to anon, authenticated;
