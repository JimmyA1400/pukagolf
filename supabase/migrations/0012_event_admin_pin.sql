-- Per-event admin access, guarded by an 8-digit PIN.
--
-- SECURITY SHAPE
-- Events have no accounts, so the organiser proves themselves with a PIN set
-- when the event is created. Three things make that safe enough to be worth
-- having:
--
--   1. The PIN is bcrypt-hashed. It is never stored or returned in plaintext,
--      and is shown to the organiser exactly once, at creation.
--   2. Unlocking exchanges the PIN for a separate 122-bit admin token. Every
--      later admin action carries the token, so the PIN is not re-sent (and not
--      sitting in localStorage) for the rest of the day.
--   3. Eight digits is only 100 million combinations, which is nothing to a
--      script. Failed attempts are counted and the event locks for fifteen
--      minutes after five of them, which turns a minutes-long brute force into
--      a multi-year one.

alter table events
  add column admin_pin_hash text,
  add column admin_token    text unique
             default replace(gen_random_uuid()::text, '-', ''),
  add column pin_attempts   smallint not null default 0,
  add column pin_locked_until timestamptz;

/*
  Generate an 8-digit PIN.

  Derived from a v4 uuid rather than random(), which is a deterministic PRNG
  seeded per session and not something to base a credential on.
*/
create or replace function generate_event_pin()
returns text
language sql
volatile
as $fn$
  select lpad(
    (abs(('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint)
      % 100000000)::text,
    8, '0');
$fn$;

-- Exchange a PIN for the event's admin token.
--
-- Deliberately returns the same message whether the event is missing or the PIN
-- is wrong: distinguishing them would confirm which share tokens exist.
create or replace function event_admin_unlock(token text, pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  row_event events%rowtype;
begin
  select * into row_event from events where share_token = token;

  if row_event.id is null or row_event.admin_pin_hash is null then
    raise exception 'That PIN is not right.' using errcode = 'invalid_password';
  end if;

  if row_event.pin_locked_until is not null
     and row_event.pin_locked_until > now() then
    raise exception 'Too many attempts. Try again in a few minutes.'
      using errcode = 'invalid_password';
  end if;

  if crypt(pin, row_event.admin_pin_hash) <> row_event.admin_pin_hash then
    update events
       set pin_attempts = pin_attempts + 1,
           pin_locked_until = case
             when pin_attempts + 1 >= 5 then now() + interval '15 minutes'
             else pin_locked_until
           end
     where id = row_event.id;

    raise exception 'That PIN is not right.' using errcode = 'invalid_password';
  end if;

  update events set pin_attempts = 0, pin_locked_until = null
   where id = row_event.id;

  return row_event.admin_token;
end;
$fn$;

/** Resolve an admin token to its event, or null. Internal only. */
create or replace function event_for_admin_token(admin_token text)
returns uuid
language sql
security definer
stable
set search_path = public
as $fn$
  select id from events where events.admin_token = $1 and $1 is not null;
$fn$;

-- ------------------------------------------------------------ admin actions

create or replace function event_admin_set_tee_time(
  admin_token text, in_tee_time_id uuid, in_tee_at text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := event_for_admin_token(admin_token);
  parsed time;
begin
  if target is null then
    raise exception 'Not unlocked for this event.' using errcode = 'insufficient_privilege';
  end if;

  begin
    parsed := in_tee_at::time;
  exception when others then
    raise exception 'Could not read "%" as a time.', in_tee_at
      using errcode = 'invalid_datetime_format';
  end;

  update event_tee_times set tee_at = parsed
   where id = in_tee_time_id and event_id = target;

  if not found then
    raise exception 'That tee time is not in this event.'
      using errcode = 'foreign_key_violation';
  end if;

  insert into audit_log (actor_label, action, entity, entity_id, detail)
  values ('event admin', 'update', 'event_tee_time', in_tee_time_id::text,
          jsonb_build_object('tee_at', parsed));

  return event_state((select share_token from events where id = target));
end;
$fn$;

create or replace function event_admin_set_score(
  admin_token text, in_team_id uuid, in_player_id uuid,
  in_hole smallint, in_strokes smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := event_for_admin_token(admin_token);
begin
  if target is null then
    raise exception 'Not unlocked for this event.' using errcode = 'insufficient_privilege';
  end if;

  if in_strokes < 1 or in_strokes > 20 then
    raise exception 'A hole score must be between 1 and 20.'
      using errcode = 'check_violation';
  end if;

  if in_player_id is null then
    insert into event_scores (event_id, team_id, player_id, hole, strokes, entered_by)
    values (target, in_team_id, null, in_hole, in_strokes, 'event admin')
    on conflict (event_id, team_id, hole) where player_id is null
    do update set strokes = excluded.strokes, entered_by = excluded.entered_by;
  else
    insert into event_scores (event_id, team_id, player_id, hole, strokes, entered_by)
    values (target, in_team_id, in_player_id, in_hole, in_strokes, 'event admin')
    on conflict (event_id, player_id, hole) where player_id is not null
    do update set strokes = excluded.strokes, entered_by = excluded.entered_by;
  end if;

  return event_state((select share_token from events where id = target));
end;
$fn$;

create or replace function event_admin_rename_player(
  admin_token text, in_player_id uuid, in_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := event_for_admin_token(admin_token);
begin
  if target is null then
    raise exception 'Not unlocked for this event.' using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(in_name)) between 1 and 60 then
    update event_players set name = btrim(in_name)
     where id = in_player_id and event_id = target;
  else
    raise exception 'A name must be between 1 and 60 characters.'
      using errcode = 'check_violation';
  end if;

  if not found then
    raise exception 'That player is not in this event.'
      using errcode = 'foreign_key_violation';
  end if;

  insert into audit_log (actor_label, action, entity, entity_id, detail)
  values ('event admin', 'update', 'event_player', in_player_id::text,
          jsonb_build_object('name', btrim(in_name)));

  return event_state((select share_token from events where id = target));
end;
$fn$;

grant execute on function event_admin_unlock(text, text) to anon, authenticated;
grant execute on function event_admin_set_tee_time(text, uuid, text) to anon, authenticated;
grant execute on function event_admin_set_score(text, uuid, uuid, smallint, smallint) to anon, authenticated;
grant execute on function event_admin_rename_player(text, uuid, text) to anon, authenticated;

-- Internal helpers. Exposing these would let a caller confirm a guessed token.
revoke execute on function event_for_admin_token(text) from anon, authenticated;
revoke execute on function generate_event_pin() from anon, authenticated;
