/*
  Let a league admin set a new admin PIN on any outing.

  The PIN is only stored as a bcrypt hash, so a forgotten one can't be looked
  up; until now the only fix was the SQL editor. Any league admin may change
  any outing's PIN, not just the outings they created: the admin_events policy
  already lets an admin edit every events row directly, so a creator-only rule
  here would be a lock beside an open window.

  Changing the PIN also issues a new admin_token. Unlocking an outing's admin
  page hands out that token and every event_admin_* function trusts it, so
  without a new one anybody who unlocked with the old PIN would keep their
  access through a change meant to take it away.
*/
create or replace function admin_set_event_pin(
  in_event_id uuid,
  in_pin      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  chosen text := nullif(btrim(in_pin), '');
  pin    text;
  outing text;
begin
  if not is_admin() then
    raise exception 'Only a league admin can change an outing''s PIN.'
      using errcode = 'insufficient_privilege';
  end if;

  select e.name into outing from events e where e.id = in_event_id;

  if outing is null then
    raise exception 'No such outing.' using errcode = 'no_data_found';
  end if;

  -- The same rules create_event applies to a chosen PIN.
  if chosen is null then
    pin := generate_event_pin();
  else
    if chosen !~ '^\d{8}$' then
      raise exception 'The admin PIN must be exactly 8 digits.'
        using errcode = 'check_violation';
    end if;

    if pin_is_weak(chosen) then
      raise exception
        'That PIN is too easy to guess. Avoid repeated digits and runs like 12345678.'
        using errcode = 'check_violation';
    end if;

    pin := chosen;
  end if;

  update events
     set admin_pin_hash   = crypt(pin, gen_salt('bf')),
         admin_token      = replace(gen_random_uuid()::text, '-', ''),
         pin_attempts     = 0,
         pin_locked_until = null
   where id = in_event_id;

  -- Never the PIN itself: the audit log is readable by every admin.
  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'event', in_event_id::text,
          jsonb_build_object('name', outing, 'admin_pin', 'changed',
                             'generated', chosen is null));

  -- Returned so a generated PIN can be shown once; only its hash is kept.
  return jsonb_build_object('pin', pin, 'generated', chosen is null);
end;
$fn$;

revoke execute on function admin_set_event_pin(uuid, text) from public, anon;
grant execute on function admin_set_event_pin(uuid, text) to authenticated;
