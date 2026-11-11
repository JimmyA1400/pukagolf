/*
  From the testers' seventh run.

  1. A hole entered with signal is no longer logged as entered on the phone.
     log_score_change took least(entered_on_phone_at, now()) for the phone's
     time, and least() passes over a null: every first entry, and every
     online correction of a hole that had waited, got now() as its phone
     time, and the card's history called it "offline". Only a phone time the
     write really brought is logged now. The lines already written keep what
     they have; the history leaves out a phone time the same as when it
     arrived.

  2. Clearing a final week no longer leaves the league two Live weeks. It
     goes back to Live only while no other week of its league is Live;
     otherwise it stays final, with its scores out of the standings, and a
     card in it is put back with "Fix a card", as in any final week.

  Replaced functions only. No score, player or league row is changed.
*/

-- ------------------------------------------------------------ the phone's time, only when there is one

-- As in 0057, with no phone time made up for a write that brought none.
create or replace function log_score_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  phone_at timestamptz;
begin
  if new.entered_on_phone_at is not null
     and (TG_OP = 'INSERT'
          or (TG_OP = 'UPDATE' and new.entered_on_phone_at is distinct from old.entered_on_phone_at)) then
    -- Never later than now: a phone's clock can be wrong.
    phone_at := least(new.entered_on_phone_at, now());
  end if;

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
         'cardWas', nullif(current_setting('pukagolf.card_was', true), ''),
         'phoneAt', phone_at)));
  return coalesce(new, old);
end;
$fn$;

-- ------------------------------------------------------------ clearing a final week

-- As in 0057, and a final week goes back to Live only when no other week of
-- its league is Live. The log says which.
create or replace function owner_clear_round_scores(in_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed    integer;
  reopened   integer;
  round_name text;
  league     uuid;
  batch_id   uuid := gen_random_uuid();
  to_live    boolean;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can clear a week.'
      using errcode = 'insufficient_privilege';
  end if;

  select name, league_id into round_name, league from rounds where id = in_round_id;

  if round_name is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  delete from cleared_scores where cleared_at < now() - interval '7 days';

  insert into cleared_scores (batch, round_id, player_id, hole, strokes, entered_by)
  select batch_id, round_id, player_id, hole, strokes, entered_by
    from scores where round_id = in_round_id;

  delete from scores where round_id = in_round_id;
  get diagnostics removed = row_count;

  -- A signed card with nothing on it can't be scored or fixed: open it.
  delete from card_locks where round_id = in_round_id;
  get diagnostics reopened = row_count;

  to_live := not exists (select 1 from rounds r
                          where r.league_id is not distinct from league
                            and r.id <> in_round_id
                            and r.status = 'live');

  if to_live then
    update rounds set status = 'live' where id = in_round_id and status = 'final';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_scores', 'round', in_round_id::text,
          jsonb_build_object('name', round_name, 'removed', removed, 'batch', batch_id,
                             'round_id', in_round_id, 'cards_reopened', reopened,
                             'back_to_live', to_live));

  return removed;
end;
$fn$;
