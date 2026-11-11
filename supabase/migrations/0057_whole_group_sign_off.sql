/*
  From the testers' fifth run.

  1. Taking back a sign-off takes back the whole group's. A sign-off is the
     group's, so freeing one card left the others signed, the admin's own
     among them, which nobody at a one-admin club could then reach.
     admin_take_back_sign_off frees every card the group signed. An admin's
     own lock (how = 'admin') stays: that is the pro shop's, not the group's.
     Unlocking a signed card one at a time (admin_set_card_lock) is now
     logged as taking the sign-off back, not as an unlock.

  2. Clearing a week's scores also takes back its sign-offs and locks. A
     signed card with nothing on it is a record nobody can fix; the log says
     how many cards were opened again.

  3. A week going final is logged, with how many cards in it weren't
     finished and whose. Starting a new week makes the old one final, and
     that used to leave only "started a week" in the log.

  4. A score sent from a phone that had waited for signal may say when it
     was entered on the phone. The card's history shows it beside the time
     the database got it.

  Additive: one nullable column, one new function, one new trigger,
  replaced functions. No score, player or league row is changed.
*/

-- ------------------------------------------------------------ when a hole was entered on the phone

alter table scores add column if not exists entered_on_phone_at timestamptz;

comment on column scores.entered_on_phone_at is
  'When the hole was entered on the phone, for a score that waited there for signal. Null when it went up at once.';

-- As in 0052, with the phone's time on an entry that waited for signal. Only
-- when this write brought it: an upsert that leaves the column alone keeps
-- the old one on the row, and that is not when this change was made.
create or replace function log_score_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  phone_at timestamptz;
begin
  if TG_OP = 'INSERT'
     or (TG_OP = 'UPDATE' and new.entered_on_phone_at is distinct from old.entered_on_phone_at) then
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

-- As in 0052, with the phone's time, and a group's sign-off taken back.
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
             'cardWas', a.detail ->> 'cardWas',
             'phoneAt', a.detail ->> 'phoneAt'
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
                 or (a.action in ('sign_off', 'take_back')
                     and a.detail ->> 'round_id' = in_round_id::text
                     and exists (select 1 from tee_time_players ttp
                                  where ttp.tee_time_id::text = a.entity_id
                                    and ttp.player_id = in_player_id))))
  ), '[]'::jsonb);
end;
$fn$;

-- ------------------------------------------------------------ the group's sign-off, taken back whole

/*
  A club admin takes back the sign-off of the group a card is in: every card
  that group signed opens again, the admin's own included. Returns how many.
  A final week or a closed season locks every card anyway, and is undone
  where it was set, so this refuses there and says so.
*/
create or replace function admin_take_back_sign_off(in_round_id uuid, in_player_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  tee    uuid;
  freed  integer;
begin
  perform assert_club_admin(round_club(in_round_id));

  if (select status from rounds where id = in_round_id) = 'final' then
    raise exception 'The week is marked final, so every card stays locked. Set it back to Live on the admin page first.'
      using errcode = 'check_violation';
  end if;

  if round_season_closed(in_round_id) then
    raise exception 'The season is closed, so every card stays locked. Reopen it on the admin page first.'
      using errcode = 'check_violation';
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
          jsonb_build_object('round_id', in_round_id, 'player_id', in_player_id, 'cards', freed));

  return freed;
end;
$fn$;

revoke execute on function admin_take_back_sign_off(uuid, uuid) from public, anon;
grant execute on function admin_take_back_sign_off(uuid, uuid) to authenticated;

-- As in 0053, except that unlocking a card the group signed is logged as
-- taking its sign-off back, so a lock and a sign-off never read the same.
create or replace function admin_set_card_lock(in_round_id uuid, in_player_id uuid, in_locked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  was text;
begin
  perform assert_club_admin(round_club(in_round_id));

  select how into was from card_locks where round_id = in_round_id and player_id = in_player_id;

  if in_locked then
    insert into card_locks (round_id, player_id, locked_by, how)
    values (in_round_id, in_player_id, auth.uid(), 'admin')
    on conflict do nothing;
  else
    delete from card_locks where round_id = in_round_id and player_id = in_player_id;
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(),
          case when in_locked then 'lock' when was = 'signed' then 'take_back' else 'unlock' end,
          'card',
          in_round_id::text || ':' || in_player_id::text,
          jsonb_build_object('round_id', in_round_id, 'player_id', in_player_id));
end;
$fn$;

-- ------------------------------------------------------------ clearing a week opens its cards

-- As in 0047, and the week's sign-offs and locks go with its scores.
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
  batch_id   uuid := gen_random_uuid();
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can clear a week.'
      using errcode = 'insufficient_privilege';
  end if;

  select name into round_name from rounds where id = in_round_id;

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

  update rounds set status = 'live' where id = in_round_id and status = 'final';

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_scores', 'round', in_round_id::text,
          jsonb_build_object('name', round_name, 'removed', removed, 'batch', batch_id,
                             'round_id', in_round_id, 'cards_reopened', reopened));

  return removed;
end;
$fn$;

-- ------------------------------------------------------------ a week going final, in the log

-- Whichever way it happens (the Final control, or starting the next week),
-- with the cards that weren't finished and whose they were.
create or replace function rounds_log_final()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  short   text[];
begin
  select coalesce(array_agg(format('%s (%s of %s)', pr.full_name, x.posted, new.hole_count)
                            order by pr.full_name), '{}')
    into short
    from (select ttp.player_id,
                 (select count(*) from scores s
                   where s.round_id = new.id and s.player_id = ttp.player_id) as posted
            from tee_time_players ttp
           where ttp.round_id = new.id) x
    join profiles pr on pr.id = x.player_id
   where x.posted < new.hole_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'final', 'round', new.id::text,
          jsonb_build_object('round_id', new.id, 'name', new.name,
                             'unfinished', cardinality(short), 'short', to_jsonb(short)));

  return new;
end;
$fn$;

drop trigger if exists log_final on rounds;
create trigger log_final
  after update of status on rounds
  for each row
  when (new.status = 'final' and old.status is distinct from 'final')
  execute function rounds_log_final();

revoke execute on function rounds_log_final() from public, anon, authenticated;
