/*
  From the testers' fourth run.

  1. Adding someone by phone who is already in the club changes nothing.
     Since 0055 it overwrote their role with the one picked on the form and
     switched off staff score-fixing, while the page said "Added to the club".
     Now an active member is left exactly as they are and the admin is told
     they're already in, as what. Someone who had asked to join, or had been
     taken out, is let in as before.

  2. A score refused because the card is locked says so. The score policies
     (0052) refuse it with a bare permission error, which the phone could
     only word as "you aren't allowed". A trigger now refuses it first, with
     who locked it and when. It only words the refusal: the policies still
     decide, and a club admin's change with a reason (admin_fix_signed_score)
     passes it as before.

  3. The club's audit log names the league of a rules or season line and the
     group a player was moved to. Each season close or reopen also records
     its league from now on.

  Additive: one new trigger, replaced functions. No row is changed.
*/

-- ------------------------------------------------------------ already in the club

-- As in 0055, except that an active member is left alone and the admin told.
create or replace function club_add_member(in_club_id uuid, in_phone text, in_role text default 'player')
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  who      uuid;
  existing club_members%rowtype;
begin
  perform assert_club_admin(in_club_id);

  if in_role not in ('admin', 'staff', 'player') then
    raise exception 'A member is an admin, staff or a player.' using errcode = 'check_violation';
  end if;

  if us_phone(in_phone) is null then
    raise exception 'Enter a 10-digit US mobile number.' using errcode = 'check_violation';
  end if;

  if not rate_limit_hit('add_member:' || auth.uid() || ':h', 60, 3600) then
    raise exception 'That''s a lot of numbers in the last hour. Try again a little later.'
      using errcode = 'check_violation';
  end if;

  who := profile_for_phone(in_phone);

  -- Not raised: an error would undo the count above. The page says
  -- "Nobody has signed up with that number yet" on a null.
  if who is null then
    return null;
  end if;

  select * into existing from club_members where club_id = in_club_id and profile_id = who;

  -- Already in: nothing to do, and nothing of theirs to change. Raised so
  -- the page can say so; undoing the count is fine, nobody new was looked up.
  if found and existing.status = 'active' then
    raise exception '% is already in the club, as %. Nothing was changed.',
      coalesce((select full_name from profiles where id = who), 'That player'),
      case existing.role when 'admin' then 'an admin' when 'staff' then 'staff' else 'a player' end
      using errcode = 'unique_violation', hint = 'already_member';
  end if;

  insert into club_members (club_id, profile_id, role, status, requested_at, decided_at, decided_by)
  values (in_club_id, who, in_role, 'active', now(), now(), auth.uid())
  on conflict (club_id, profile_id) do update
    set role = excluded.role, status = 'active', staff_can_edit_scores = false,
        decided_at = now(), decided_by = auth.uid();

  perform sync_pukagolf_admin(in_club_id, who);

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'add', 'club_member', who::text,
          jsonb_build_object('club_id', in_club_id, 'role', in_role));

  return who;
end;
$fn$;

revoke execute on function club_add_member(uuid, text, text) from public, anon;
grant execute on function club_add_member(uuid, text, text) to authenticated;

-- ------------------------------------------------------------ a locked card says so

create or replace function scores_say_card_locked()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  lock  card_locks%rowtype;
  who   text;
  zone  text;
  week  rounds%rowtype;
begin
  -- A club admin's change with a reason goes through; the policies decide.
  if coalesce(current_setting('pukagolf.change_reason', true), '') <> '' then
    return new;
  end if;

  if not score_needs_reason(new.round_id, new.player_id) then
    return new;
  end if;

  -- Only for someone writing their own entry onto a card they could keep or
  -- fix if it weren't locked. Anyone else (another club, a card that isn't
  -- theirs) gets the policies' plain refusal and learns nothing about the
  -- lock; the database's own jobs, like putting cleared scores back, pass.
  if new.entered_by is distinct from auth.uid()
     or not ((new.player_id <> auth.uid() and can_fix_scores(round_club(new.round_id)))
             or may_score(new.round_id, new.player_id)) then
    return new;
  end if;

  select * into week from rounds where id = new.round_id;
  select coalesce(c.time_zone, 'America/New_York') into zone
    from leagues l join clubs c on c.id = l.club_id where l.id = week.league_id;
  select * into lock from card_locks where round_id = new.round_id and player_id = new.player_id;
  select full_name into who from profiles where id = lock.locked_by;

  raise exception '%',
    case
      when lock.round_id is not null then
        format('The card is locked: %s by %s, %s. Only a club admin can change it now.',
               case lock.how when 'admin' then 'locked' else 'signed off' end,
               coalesce(who, case lock.how when 'admin' then 'a club admin' else 'the group' end),
               to_char(lock.locked_at at time zone zone, 'Mon FMDD, FMHH12:MI AM'))
      when week.status = 'final' then
        'The card is locked: the week is marked final. Only a club admin can change it now.'
      else
        'The card is locked: the season is closed. Only a club admin can change it now.'
    end
    using errcode = 'check_violation', hint = 'card_locked';
end;
$fn$;

drop trigger if exists say_card_locked on scores;
create trigger say_card_locked
  before insert or update on scores
  for each row execute function scores_say_card_locked();

revoke execute on function scores_say_card_locked() from public, anon, authenticated;

-- ------------------------------------------------------------ seasons carry their league

-- A season close or reopen names its league, found from what the admin just
-- did: the season closed in this same transaction, or, for a reopen, the
-- latest close of that year in a club they run.
create or replace function audit_log_season_league()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  found uuid;
begin
  if new.entity <> 'season' or new.detail ? 'league_id' or new.entity_id !~ '^\d{4}$' then
    return new;
  end if;

  if new.action = 'close' then
    select s.league_id into found
      from seasons s join leagues l on l.id = s.league_id
     where s.year = new.entity_id::integer and s.closed_at = now()
       and is_club_admin(l.club_id)
     limit 1;
  elsif new.action = 'reopen' then
    select (a.detail ->> 'league_id')::uuid into found
      from audit_log a
     where a.entity = 'season' and a.action = 'close' and a.entity_id = new.entity_id
       and a.detail ? 'league_id'
       and is_club_admin((select club_id from leagues where id = (a.detail ->> 'league_id')::uuid))
     order by a.at desc
     limit 1;
  end if;

  if found is not null then
    new.detail := coalesce(new.detail, '{}'::jsonb) || jsonb_build_object('league_id', found);
  end if;
  return new;
end;
$fn$;

-- Runs before the club is worked out (triggers fire in name order), so the
-- league it adds places the entry in its club too.
drop trigger if exists audit_log_a_season_league on audit_log;
create trigger audit_log_a_season_league
  before insert on audit_log
  for each row execute function audit_log_season_league();

revoke execute on function audit_log_season_league() from public, anon, authenticated;

-- ------------------------------------------------------------ the log names leagues and groups

-- As in 0054, with the league a line is about and the group a player went to.
create or replace function club_audit_log(
  in_club_id uuid,
  in_limit   integer default 50,
  in_before  timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not is_club_admin(in_club_id) then
    raise exception 'Only the club''s admins can read its log.'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(x.entry order by x.at desc, x.id desc)
      from (
        select a.at, a.id,
               jsonb_build_object(
                 'id',       a.id,
                 'at',       a.at,
                 'actor',    coalesce(p.full_name, a.actor_label, 'System'),
                 'action',   a.action,
                 'entity',   a.entity,
                 'entityId', a.entity_id,
                 'detail',   a.detail,
                 'player',   (select full_name from profiles
                               where id::text = coalesce(a.detail ->> 'player_id',
                                                         case when a.entity in ('player', 'handicap', 'club_member', 'league_member', 'pairing')
                                                              then a.entity_id end)),
                 'week',     (select r.name || ' · ' || l.name
                                from rounds r join leagues l on l.id = r.league_id
                               where r.id::text = coalesce(a.detail ->> 'round_id',
                                                           case when a.entity = 'round' then a.entity_id end)),
                 'league',   (select l.name from leagues l
                               where l.id::text = coalesce(a.detail ->> 'league_id',
                                                           case when a.entity in ('league', 'league_rules') then a.entity_id end)),
                 'toGroup',  (select 'Group ' || g.n
                                from (select t.id, row_number() over (order by t.tee_at, t.id) as n
                                        from tee_times t
                                       where t.round_id::text = a.detail ->> 'round_id') g
                               where a.entity = 'pairing' and g.id::text = a.detail ->> 'to')
               ) as entry
          from audit_log a
          left join profiles p on p.id = a.actor_id
         where a.club_id = in_club_id
           and (in_before is null or a.at < in_before)
         order by a.at desc, a.id desc
         limit least(greatest(coalesce(in_limit, 50), 1), 200)
      ) as x
  ), '[]'::jsonb);
end;
$fn$;

revoke execute on function club_audit_log(uuid, integer, timestamptz) from public, anon;
grant execute on function club_audit_log(uuid, integer, timestamptz) to authenticated;

-- ------------------------------------------------------------ weather on an outing, signed out

/*
  An outing needs no account, so its weather strip can't need one either.
  Since 0055 every lookup asked for a sign-in, and the strip on an outing
  page stayed blank. A signed-out lookup is allowed for an outing's own
  link: it gets that outing's location (never one the caller names, so this
  can't be used to look up anywhere), and the same per-network ration as
  any lookup, plus one for the outing itself.

  Returns the outing's place as {latitude, longitude}; {"limited": true}
  over the ration; null for a link that isn't an outing or has no place.
*/
create or replace function api_outing_weather_place(in_token text, in_ip text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  place events%rowtype;
begin
  select * into place from events where share_token = in_token;
  if not found or place.latitude is null or place.longitude is null then
    return null;
  end if;

  if coalesce(in_ip ~ '^[0-9a-f]{32}$', false)
     and not rate_limit_hit('lookup:ip:' || in_ip || ':m', 120, 60) then
    return jsonb_build_object('limited', true);
  end if;

  if not rate_limit_hit('lookup:outing:' || place.id || ':m', 60, 60) then
    return jsonb_build_object('limited', true);
  end if;

  return jsonb_build_object('latitude', place.latitude, 'longitude', place.longitude);
end;
$fn$;

revoke execute on function api_outing_weather_place(text, text) from public;
grant execute on function api_outing_weather_place(text, text) to anon, authenticated;
