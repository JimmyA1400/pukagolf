-- Run on the TEST project after the restore, never on live.
--
-- A dump carries the public schema but not changes made to Supabase's own
-- auth schema, so the three triggers the app hangs on auth.users have to be
-- put back by hand. Without them a new signup gets no profile, a changed
-- phone number never reaches the profile, and a deleted login leaves its
-- profile behind. Definitions are copied from migrations 0002, 0026 and 0035;
-- the functions they call came across in the dump.
--
-- The realtime list is re-applied for the same reason: live scores and the
-- feed only update on screen for tables in that publication.

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists on_auth_user_phone_changed on auth.users;
create trigger on_auth_user_phone_changed
  after update on auth.users
  for each row execute function public.sync_user_phone();

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public.remove_deleted_user_profile();

do $$
declare
  t text;
begin
  foreach t in array array[
    'scores', 'scorer_assignments', 'tee_time_requests',
    'round_settings', 'feed_posts', 'event_scores'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
