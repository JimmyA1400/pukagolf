/*
  Rations, so the free tiers survive the demo.

  1. The course, place and weather lookups (/api/courses, /api/geocode,
     /api/weather) each call a free outside service on our behalf. They now
     need a signed-in account, and api_lookup_allowed() keeps a count: an
     account gets 60 lookups a minute and 600 an hour, and one network (a
     fingerprint of its address, never the address itself) gets 120 a minute
     across every account on it, so a clubhouse full of phones on one wifi is
     still fine. Normal use is a handful a minute: the weather strip asks once
     every 15 minutes, a course search once per word typed.

  2. Adding a member by phone number (club_add_member) gets a ration too: 60
     numbers an hour for each admin. It never sends a text, but each try says
     whether that number has an account, so it shouldn't be a way to test a
     list of numbers. To make the misses count, a number nobody has signed up
     with now returns null instead of raising: an error would undo the count
     along with everything else. The admin page says the same words as before.

  The counts live in rate_limits, which nobody reads or writes directly; old
  rows are swept as new ones come in. Additive and re-runnable: one new
  table, one new function, and club_add_member replaced.
*/

-- ------------------------------------------------------------ the counter

create table if not exists rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket, window_start)
);

-- On, with no policies: only the functions below can touch it.
alter table rate_limits enable row level security;
revoke all on rate_limits from public, anon, authenticated;

/*
  Count one hit against a bucket in the current fixed window, and say whether
  it is still within the limit. A hit over the limit still counts, so hammering
  away doesn't earn a sooner reset.
*/
create or replace function rate_limit_hit(in_bucket text, in_limit integer, in_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  started timestamptz := to_timestamp(floor(extract(epoch from now()) / in_window_seconds) * in_window_seconds);
  n integer;
begin
  insert into rate_limits (bucket, window_start, hits)
  values (in_bucket, started, 1)
  on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1
  returning hits into n;

  -- Now and then, sweep windows nobody will ask about again.
  if random() < 0.02 then
    delete from rate_limits where window_start < now() - interval '1 day';
  end if;

  return n <= in_limit;
end;
$fn$;

revoke execute on function rate_limit_hit(text, integer, integer) from public, anon, authenticated;

-- ------------------------------------------------------------ lookups

/*
  Called by the lookup routes, as the signed-in user, before each lookup.
  in_ip is the route's fingerprint of the caller's address, or null when it
  has none. Anything that isn't a fingerprint is ignored rather than stored,
  so the table can't be filled with junk keys; and the account's own ration
  is checked first, so a caller can't make up fingerprints faster than that.
*/
create or replace function api_lookup_allowed(in_ip text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if not rate_limit_hit('lookup:user:' || me || ':m', 60, 60) then
    return false;
  end if;

  if not rate_limit_hit('lookup:user:' || me || ':h', 600, 3600) then
    return false;
  end if;

  if coalesce(in_ip ~ '^[0-9a-f]{32}$', false) then
    if not rate_limit_hit('lookup:ip:' || in_ip || ':m', 120, 60) then
      return false;
    end if;
  end if;

  return true;
end;
$fn$;

revoke execute on function api_lookup_allowed(text) from public, anon;
grant execute on function api_lookup_allowed(text) to authenticated;

-- ------------------------------------------------------------ adding members

create or replace function club_add_member(in_club_id uuid, in_phone text, in_role text default 'player')
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  who uuid;
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
