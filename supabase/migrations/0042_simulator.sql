/*
  Marking a round as played indoors, and saying what that is worth.

  A simulator score is a real score, played somewhere that rolls perfectly and
  never gives a bad lie. Throwing it away loses a winter's golf; counting it in
  full flatters everyone who plays through the winter. So it counts, at a
  weight the owner sets, and it is labelled wherever it appears.

  The weighting itself is in src/lib/handicap.ts, with a note there saying
  plainly that it is a house rule and not WHS — the published method has no
  concept of a weight, because it takes the lowest 8 of your last 20 and a
  selection cannot be weighted.

  Nothing else needs a migration: rounds.is_simulator, events.is_simulator and
  league_settings.simulator_weight all arrived with 0040.
*/

create or replace function owner_set_simulator_weight(in_weight numeric)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can change what a simulator round is worth.'
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
$fn$;

/*
  A week played indoors.

  Allowed at any point: the flag changes how the scores are weighed, never the
  scores, so a week marked wrongly can be put right afterwards and every index
  recalculates from the same cards.
*/
create or replace function admin_set_week_simulator(in_round_id uuid, in_value boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_admin() then
    raise exception 'Only an admin can change the week.'
      using errcode = 'insufficient_privilege';
  end if;

  update rounds set is_simulator = coalesce(in_value, false) where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('is_simulator', coalesce(in_value, false)));
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function owner_set_simulator_weight(numeric) from public, anon;
revoke execute on function admin_set_week_simulator(uuid, boolean) from public, anon;

grant execute on function owner_set_simulator_weight(numeric) to authenticated;
grant execute on function admin_set_week_simulator(uuid, boolean) to authenticated;
