-- Player details captured at signup, and RSVPs for upcoming rounds.
--
-- A league round IS the league's upcoming event: it already has a date, tee
-- times and a status, so RSVPs hang off rounds rather than inventing a parallel
-- "event" concept that would need keeping in step with it.

alter table profiles
  add column phone text
    -- E.164 only. Anything else cannot be dialled and is not worth storing.
    check (phone is null or phone ~ '^\+1[2-9]\d{2}[2-9]\d{6}$'),
  -- Self-reported at signup. A PLUS handicap is better than scratch and is
  -- stored negative: a "+1.4" player is -1.4 here. Getting that backwards
  -- makes the best player look like the worst.
  add column handicap_index numeric(3, 1)
    check (handicap_index is null or handicap_index between -10 and 54),
  add column preferred_tee_time time,
  add column preferred_tee text,
  add column phone_verified boolean not null default false;

-- After this moment the pairings are set and a player cannot remove themselves.
alter table rounds
  add column rsvp_lock_at timestamptz;

create type rsvp_status as enum ('in', 'out', 'undecided');

create table round_rsvps (
  round_id   uuid not null references rounds on delete cascade,
  player_id  uuid not null references profiles on delete cascade,
  status     rsvp_status not null default 'undecided',
  -- Set when an admin overrides a player's own answer, so the two are
  -- distinguishable after the fact.
  set_by     uuid references profiles on delete set null,
  updated_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

create index round_rsvps_round on round_rsvps (round_id, status);

create trigger round_rsvps_touch before update on round_rsvps
  for each row execute function touch_updated_at();

alter table round_rsvps enable row level security;

-- Everyone in the league sees who is playing; that is the point of an RSVP.
create policy read_rsvps on round_rsvps for select to authenticated using (true);

-- A player answers for themselves, and only before the lock.
create policy own_rsvp_insert on round_rsvps for insert to authenticated
  with check (
    player_id = auth.uid()
    and exists (
      select 1 from rounds r
       where r.id = round_id
         and (r.rsvp_lock_at is null or r.rsvp_lock_at > now())
    )
  );

create policy own_rsvp_update on round_rsvps for update to authenticated
  using (player_id = auth.uid())
  with check (
    player_id = auth.uid()
    and exists (
      select 1 from rounds r
       where r.id = round_id
         and (r.rsvp_lock_at is null or r.rsvp_lock_at > now())
    )
  );

-- The admin answers for anyone, before or after the lock.
create policy admin_rsvp on round_rsvps for all to authenticated
  using (is_admin()) with check (is_admin());

-- Players maintain their own profile; the admin maintains anyone's.
create policy own_profile_update on profiles for update to authenticated
  using (id = auth.uid())
  -- is_admin is deliberately absent from what a player may change: the check
  -- below re-asserts the stored value, so a player cannot promote themselves
  -- by sending is_admin = true.
  with check (
    id = auth.uid()
    and is_admin = (select p.is_admin from profiles p where p.id = auth.uid())
  );

-- ------------------------------------------------------------- validation

/*
  Server-side validation of what signup collects.

  The client validates too, for the error messages, but nothing here trusts it:
  a POST straight to PostgREST bypasses the form entirely.
*/
create or replace function save_player_details(
  in_full_name          text,
  in_phone              text,
  in_handicap_index     numeric,
  in_preferred_tee_time time,
  in_preferred_tee      text
)
returns jsonb
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

  if length(btrim(coalesce(in_full_name, ''))) < 2 then
    raise exception 'Enter your first and last name.'
      using errcode = 'check_violation';
  end if;

  if in_phone is not null and in_phone !~ '^\+1[2-9]\d{2}[2-9]\d{6}$' then
    raise exception 'That phone number is not a valid US number.'
      using errcode = 'check_violation';
  end if;

  if in_handicap_index is not null
     and (in_handicap_index < -10 or in_handicap_index > 54) then
    raise exception 'A handicap index runs from +10 to 54.'
      using errcode = 'check_violation';
  end if;

  update profiles
     set full_name          = btrim(in_full_name),
         phone              = in_phone,
         handicap_index     = in_handicap_index,
         preferred_tee_time = in_preferred_tee_time,
         preferred_tee      = nullif(btrim(coalesce(in_preferred_tee, '')), '')
   where id = me;

  return (select to_jsonb(p) - 'is_admin' from profiles p where p.id = me);
end;
$fn$;

revoke execute on function save_player_details(text, text, numeric, time, text)
  from public;
grant execute on function save_player_details(text, text, numeric, time, text)
  to authenticated;

/*
  Set an RSVP.

  The lock is enforced here as well as in the policy, so the refusal carries a
  message a player can act on rather than an opaque policy violation.
*/
create or replace function set_rsvp(
  in_round_id uuid,
  in_status   text,
  in_player_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me     uuid := auth.uid();
  target uuid := coalesce(in_player_id, auth.uid());
  locked timestamptz;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if target <> me and not is_admin() then
    raise exception 'You can only change your own RSVP.'
      using errcode = 'insufficient_privilege';
  end if;

  select rsvp_lock_at into locked from rounds where id = in_round_id;

  if locked is not null and locked <= now() and not is_admin() then
    raise exception
      'Pairings are set for this round. Contact the admin to change your RSVP.'
      using errcode = 'check_violation';
  end if;

  insert into round_rsvps (round_id, player_id, status, set_by)
  values (in_round_id, target, in_status::rsvp_status, me)
  on conflict (round_id, player_id) do update
    set status = excluded.status, set_by = excluded.set_by;

  return jsonb_build_object('round_id', in_round_id, 'player_id', target,
                            'status', in_status);
end;
$fn$;

revoke execute on function set_rsvp(uuid, text, uuid) from public;
grant execute on function set_rsvp(uuid, text, uuid) to authenticated;
