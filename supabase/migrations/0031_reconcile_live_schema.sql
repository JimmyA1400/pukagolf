/*
  Bring production back in step with these files.

  Several early migrations were applied through the SQL editor in trimmed or
  edited form, so the repo stopped being an exact record of the live database.
  A full comparison on 2026-09-11 (scripts/drift-check.py: every function body
  fingerprinted with comments and whitespace ignored, plus every table, policy
  and trigger) found exactly two differences. Every table, policy and trigger
  matched, and no function was missing its latest version or left behind as an
  old overload.

  1. seed_standard_pars() is defined in 0002 but was never applied, and nothing
     calls it — 0014 already guards its revoke with to_regprocedure because of
     this. Dropped here, so a database built from these files ends up the same
     as production instead of carrying a helper production never had.

  2. event_admin_rename_player() in production differs in its body from 0012's
     version: same arguments, same return type, and it has the same length
     check, not-found check, audit write and return. 0012 is the reviewed copy,
     so it is re-created here verbatim and the two agree. CREATE OR REPLACE
     keeps the function's existing grants.
*/

drop function if exists seed_standard_pars(uuid);

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
