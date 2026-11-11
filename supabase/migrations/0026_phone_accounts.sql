/*
  Accounts are made with a mobile number, not an email address.

  Supabase texts a code and sets phone_confirmed_at when it is entered, so the
  number on the profile is a confirmed one rather than something typed into a
  form. auth.users.phone holds E.164 WITHOUT the leading plus, which the
  profiles constraint requires, so every read of it is prefixed here.
*/

create or replace function profile_phone(raw text)
returns text
language sql
immutable
as $fn$
  select case
    when raw is null or btrim(raw) = '' then null
    when left(btrim(raw), 1) = '+' then btrim(raw)
    else '+' || btrim(raw)
  end;
$fn$;

/*
  A profile row follows every new account.

  full_name is not null, and a phone signup carries no email to fall back on,
  so an account made without a name would have failed the insert and taken the
  signup down with it.
*/
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into profiles (id, full_name, phone, phone_verified)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      new.email,
      profile_phone(new.phone),
      'New player'
    ),
    profile_phone(new.phone),
    new.phone_confirmed_at is not null
  )
  on conflict (id) do nothing;

  return new;
end;
$fn$;

/*
  Keep the profile in step when the number is confirmed, or later changed.

  The code is entered after the row already exists, so without this the profile
  would sit unverified with no number on it forever.
*/
create or replace function sync_user_phone()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.phone is distinct from old.phone
     or new.phone_confirmed_at is distinct from old.phone_confirmed_at then
    update profiles
       set phone = coalesce(profile_phone(new.phone), phone),
           phone_verified = new.phone_confirmed_at is not null
     where id = new.id;
  end if;

  return new;
end;
$fn$;

drop trigger if exists on_auth_user_phone_changed on auth.users;
create trigger on_auth_user_phone_changed
  after update on auth.users
  for each row execute function sync_user_phone();

/*
  Promote by number, since make_admin() looks accounts up by email and phone
  accounts have none.

  Bootstrapping only, like make_admin: run from the SQL editor, never callable
  from the app. Revoked from PUBLIC as well as the two API roles — CREATE
  FUNCTION grants EXECUTE to PUBLIC by default, and revoking from anon and
  authenticated alone leaves that grant standing.
*/
create or replace function make_admin_by_phone(user_phone text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $fn$
declare
  wanted text := profile_phone(user_phone);
  target uuid;
begin
  select id into target
    from auth.users
   where profile_phone(phone) = wanted;

  if target is null then
    raise exception 'No account signed up with %.', wanted;
  end if;

  update profiles set is_admin = true where id = target;
end;
$fn$;

revoke execute on function make_admin_by_phone(text) from public;
revoke execute on function make_admin_by_phone(text) from anon;
revoke execute on function make_admin_by_phone(text) from authenticated;

revoke execute on function profile_phone(text) from public;
revoke execute on function profile_phone(text) from anon;

/*
  Backfill: accounts that confirmed a number before this migration existed have
  it on auth.users and nowhere else.
*/
update profiles p
   set phone = coalesce(p.phone, profile_phone(u.phone)),
       phone_verified = p.phone_verified or u.phone_confirmed_at is not null
  from auth.users u
 where u.id = p.id
   and u.phone is not null;
