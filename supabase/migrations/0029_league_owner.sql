/*
  The league owner, and the controls only the owner gets.

  Admins run the day: scores, pairings, outings. The owner can also reset a
  week, start the next one, and decide who is in the league and who is an
  admin. That is one account, set here by email.

  The owner lives in its own table rather than as a flag on profiles. Players
  may update their own profile row (own_profile_update), and every column
  added there has to be pinned in that policy's WITH CHECK or a player could
  set it on themselves. A separate table with no policies at all cannot be
  written through the API by anyone; only SQL run here can change the owner.

  Every owner_* function checks is_owner() itself, so the /admin page hiding
  itself from other accounts is a courtesy, not the lock.
*/

-- ------------------------------------------------------------ the owner

create table if not exists league_owner (
  -- One row, ever: the primary key can only be true.
  singleton  boolean primary key default true check (singleton),
  profile_id uuid not null unique references profiles on delete restrict,
  set_at     timestamptz not null default now()
);

alter table league_owner enable row level security;
-- Deliberately no policies. Nothing reaches this table through the API.

do $owner$
declare
  target      uuid;
  owner_email text := lower(btrim(coalesce(
                        current_setting('app.owner_email', true), '')));
begin
  /*
    The owner's address is not in the repo. Give it to the session that runs
    the migrations:

      set app.owner_email = 'you@example.com';

    or leave it unset here and run supabase/seed/owner.local.sql afterwards
    (see owner.local.sql.example). .env.example documents the matching
    LEAGUE_OWNER_EMAIL. Unset, this block does nothing rather than failing,
    so a fresh clone migrates cleanly before anyone has signed up.
  */
  if owner_email = '' then
    raise notice 'app.owner_email is not set, so no owner was set. See supabase/seed/owner.local.sql.example.';
    return;
  end if;

  select u.id into target
    from auth.users u
    join profiles p on p.id = u.id
   where lower(u.email) = owner_email;

  if target is null then
    raise notice 'No account uses %, so no owner was set. Sign up, then run supabase/seed/owner.local.sql.', owner_email;
    return;
  end if;

  insert into league_owner (profile_id) values (target)
  on conflict (singleton) do update
    set profile_id = excluded.profile_id, set_at = now();

  -- The owner is always an admin too; everything admins can do, they can.
  update profiles set is_admin = true where id = target;
end;
$owner$;

create or replace function is_owner()
returns boolean
language sql
security definer
stable
set search_path = public
as $fn$
  select exists (select 1 from league_owner where profile_id = auth.uid());
$fn$;

revoke execute on function is_owner() from public;
revoke execute on function is_owner() from anon;
grant execute on function is_owner() to authenticated;

-- ------------------------------------------- phone_verified is not yours

/*
  own_profile_update pinned is_admin but not phone_verified, so any player
  could mark their own number verified without ever receiving a code. The
  flag is meant to mean Twilio confirmed the number; only sync_user_phone
  (security definer) should set it.
*/
drop policy if exists own_profile_update on profiles;
create policy own_profile_update on profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and is_admin = (select p.is_admin from profiles p where p.id = auth.uid())
    and phone_verified =
        (select p.phone_verified from profiles p where p.id = auth.uid())
  );

-- -------------------------------------------------------- scoring ring

/*
  Rebuild one group's ring from whoever is left in it, in seat order: each
  player keeps the next player's card, the last wraps to the first. Used
  when a player is removed, because the cascade takes their assignments with
  them and leaves one player with no card and another with no scorer.

  Replaces the group's assignments outright, so a ring an admin rewired by
  hand goes back to seat order. Only called for groups the removed player
  was actually in.
*/
create or replace function rebuild_scoring_ring(in_tee_time_id uuid)
returns void
language plpgsql
set search_path = public
as $fn$
declare
  members uuid[];
  n       int;
begin
  select array_agg(player_id order by position) into members
    from tee_time_players
   where tee_time_id = in_tee_time_id;

  delete from scorer_assignments where tee_time_id = in_tee_time_id;

  n := coalesce(array_length(members, 1), 0);

  -- A group of one has nobody to score them; leave it for the admin.
  if n < 2 then
    return;
  end if;

  for i in 1 .. n loop
    insert into scorer_assignments (tee_time_id, scored_player_id, scorer_player_id)
    values (in_tee_time_id, members[(i % n) + 1], members[i]);
  end loop;
end;
$fn$;

revoke execute on function rebuild_scoring_ring(uuid) from public;
revoke execute on function rebuild_scoring_ring(uuid) from anon;
revoke execute on function rebuild_scoring_ring(uuid) from authenticated;

-- ------------------------------------------------------------ overview

/*
  Everything the admin page shows, in one call. "This week" is the latest
  round by date, the same rule the league page uses to pick what to show.
*/
create or replace function owner_league_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  current_id uuid;
begin
  if not is_owner() then
    raise exception 'Only the league owner can open this.'
      using errcode = 'insufficient_privilege';
  end if;

  select id into current_id
    from rounds order by played_on desc, created_at desc limit 1;

  return jsonb_build_object(
    'currentRoundId', current_id,

    'rounds', coalesce((
      select jsonb_agg(x.r order by x.played desc, x.created desc)
        from (
          select rd.played_on as played,
                 rd.created_at as created,
                 jsonb_build_object(
                   'id',           rd.id,
                   'name',         rd.name,
                   'playedOn',     rd.played_on,
                   'status',       rd.status,
                   'courseName',   co.name,
                   'holeCount',    rd.hole_count,
                   'scoreCount',   (select count(*) from scores s where s.round_id = rd.id),
                   'playerCount',  (select count(*) from tee_time_players t where t.round_id = rd.id),
                   'feedCount',    (select count(*) from feed_posts f where f.round_id = rd.id),
                   'skinsEnabled', rs.skins_enabled,
                   'skinsStake',   rs.skins_stake
                 ) as r
            from rounds rd
            left join courses co on co.id = rd.course_id
            left join round_settings rs on rs.round_id = rd.id
        ) as x
    ), '[]'::jsonb),

    'players', coalesce((
      select jsonb_agg(y.p order by y.name)
        from (
          select pr.full_name as name,
                 jsonb_build_object(
                   'id',             pr.id,
                   'name',           pr.full_name,
                   'isAdmin',        pr.is_admin,
                   'isOwner',        exists (select 1 from league_owner o where o.profile_id = pr.id),
                   -- Email for older accounts, the number for phone ones: enough to
                   -- tell two people with the same name apart.
                   'contact',        coalesce(nullif(u.email, ''), profile_phone(u.phone)),
                   'joined',         pr.created_at::date,
                   'handicapIndex',  pr.handicap_index,
                   'inCurrentRound', exists (
                     select 1 from tee_time_players t
                      where t.round_id = current_id and t.player_id = pr.id
                   ),
                   'roundsPlayed',   (
                     select count(distinct s.round_id) from scores s where s.player_id = pr.id
                   )
                 ) as p
            from profiles pr
            left join auth.users u on u.id = pr.id
        ) as y
    ), '[]'::jsonb),

    'demo', (
      select jsonb_build_object(
               'id', e.id,
               'name', e.name,
               'scoreCount', (select count(*) from event_scores es where es.event_id = e.id)
             )
        from events e
       where e.is_demo
       limit 1
    )
  );
end;
$fn$;

-- ------------------------------------------------------------ this week

/*
  Wipe a week's scores. A final week with no scores in it is not finished
  any more, so it reopens as live. Each deleted score is still recorded by
  the scores_audited trigger, so the audit log keeps what was there.
*/
create or replace function owner_clear_round_scores(in_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed    integer;
  round_name text;
begin
  if not is_owner() then
    raise exception 'Only the league owner can clear a week.'
      using errcode = 'insufficient_privilege';
  end if;

  select name into round_name from rounds where id = in_round_id;

  if round_name is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  delete from scores where round_id = in_round_id;
  get diagnostics removed = row_count;

  update rounds set status = 'live' where id = in_round_id and status = 'final';

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_scores', 'round', in_round_id::text,
          jsonb_build_object('name', round_name, 'removed', removed));

  return removed;
end;
$fn$;

create or replace function owner_clear_round_feed(in_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed    integer;
  round_name text;
begin
  if not is_owner() then
    raise exception 'Only the league owner can clear the clubhouse feed.'
      using errcode = 'insufficient_privilege';
  end if;

  select name into round_name from rounds where id = in_round_id;

  if round_name is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  delete from feed_posts where round_id = in_round_id;
  get diagnostics removed = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_feed', 'round', in_round_id::text,
          jsonb_build_object('name', round_name, 'removed', removed));

  return removed;
end;
$fn$;

create or replace function owner_update_round(
  in_round_id  uuid,
  in_name      text,
  in_played_on date,
  in_status    text
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can edit a week.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the week a name.' using errcode = 'check_violation';
  end if;

  if in_played_on is null then
    raise exception 'Pick a date.' using errcode = 'check_violation';
  end if;

  if in_status not in ('setup', 'live', 'final') then
    raise exception 'Status is setting up, live or final.'
      using errcode = 'check_violation';
  end if;

  update rounds
     set name = btrim(in_name), played_on = in_played_on, status = in_status
   where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('name', btrim(in_name), 'played_on', in_played_on,
                             'status', in_status));
end;
$fn$;

-- ------------------------------------------------------------ next week

/*
  A fresh week: the same groups, seats and scorer rotation as the latest
  week, moved to the new date, with every card blank. Skins settings carry
  over. The week before is marked final and keeps its scores, because those
  are what handicaps are calculated from.

  Copies rather than calling build_round: build_round puts every profile in
  the league into a group, which would sweep in anyone who has signed up but
  isn't playing.
*/
create or replace function owner_start_new_week(in_name text, in_played_on date)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  prev      rounds%rowtype;
  new_round uuid;
  shift     interval;
  tt        record;
  new_tee   uuid;
begin
  if not is_owner() then
    raise exception 'Only the league owner can start a new week.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the week a name.' using errcode = 'check_violation';
  end if;

  select * into prev
    from rounds order by played_on desc, created_at desc limit 1;

  if not found then
    raise exception 'There is no week to carry forward yet.'
      using errcode = 'no_data_found';
  end if;

  if in_played_on is null or in_played_on <= prev.played_on then
    raise exception 'The new week has to come after %.', prev.played_on
      using errcode = 'check_violation';
  end if;

  -- rounds_get_settings creates this week's round_settings row.
  insert into rounds (name, played_on, hole_count, status, course_id, format)
  values (btrim(in_name), in_played_on, prev.hole_count, 'live',
          prev.course_id, prev.format)
  returning id into new_round;

  shift := (in_played_on - prev.played_on) * interval '1 day';

  for tt in
    select id, tee_at, starting_hole
      from tee_times where round_id = prev.id order by tee_at
  loop
    insert into tee_times (round_id, tee_at, starting_hole)
    values (new_round, tt.tee_at + shift, tt.starting_hole)
    returning id into new_tee;

    insert into tee_time_players (tee_time_id, round_id, player_id, position)
    select new_tee, new_round, player_id, position
      from tee_time_players where tee_time_id = tt.id;

    insert into scorer_assignments (tee_time_id, scored_player_id, scorer_player_id)
    select new_tee, scored_player_id, scorer_player_id
      from scorer_assignments where tee_time_id = tt.id;
  end loop;

  update round_settings ns
     set skins_enabled = os.skins_enabled,
         skins_stake   = os.skins_stake
    from round_settings os
   where ns.round_id = new_round
     and os.round_id = prev.id;

  update rounds set status = 'final' where id = prev.id and status <> 'final';

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'round', new_round::text,
          jsonb_build_object('name', btrim(in_name), 'played_on', in_played_on,
                             'carried_from', prev.id));

  return new_round;
end;
$fn$;

-- -------------------------------------------------------------- players

create or replace function owner_set_admin(in_profile_id uuid, in_is_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can change who is an admin.'
      using errcode = 'insufficient_privilege';
  end if;

  if not in_is_admin
     and exists (select 1 from league_owner where profile_id = in_profile_id) then
    raise exception 'The owner is always an admin.'
      using errcode = 'check_violation';
  end if;

  update profiles set is_admin = in_is_admin where id = in_profile_id;

  if not found then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'player', in_profile_id::text,
          jsonb_build_object('is_admin', in_is_admin));
end;
$fn$;

/*
  Remove a player from the league: their account, their cards, their posts.

  Before the account goes, two things are handed to the owner so the cascade
  doesn't take other people's data with it: scores this player entered on
  someone else's card (scores.entered_by has no cascade, so the delete would
  fail outright), and any outings they created (events cascade on
  created_by). Afterwards, every unfinished group they were in gets its
  scoring ring re-closed.
*/
create or replace function owner_remove_player(in_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  who      text;
  affected uuid[];
  t        uuid;
begin
  if not is_owner() then
    raise exception 'Only the league owner can remove a player.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_profile_id = auth.uid()
     or exists (select 1 from league_owner where profile_id = in_profile_id) then
    raise exception 'The owner can''t be removed.'
      using errcode = 'check_violation';
  end if;

  select full_name into who from profiles where id = in_profile_id;

  if who is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  select coalesce(array_agg(distinct ttp.tee_time_id), '{}') into affected
    from tee_time_players ttp
    join rounds r on r.id = ttp.round_id
   where ttp.player_id = in_profile_id
     and r.status <> 'final';

  update scores set entered_by = auth.uid() where entered_by = in_profile_id;
  update events set created_by = auth.uid() where created_by = in_profile_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'delete', 'player', in_profile_id::text,
          jsonb_build_object('name', who,
                             'open_groups', coalesce(array_length(affected, 1), 0)));

  -- Cascades to profiles and everything hanging off it.
  delete from auth.users where id = in_profile_id;

  foreach t in array affected loop
    perform rebuild_scoring_ring(t);
  end loop;
end;
$fn$;

-- ---------------------------------------------------------- demo outing

/*
  Reset the home page's demo outing for the next visitor. Admin rather than
  owner: the button lives on the demo's card in All outings too.
*/
create or replace function admin_clear_demo_scores()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed integer;
  demo_id uuid;
begin
  if not is_admin() then
    raise exception 'Admins only.' using errcode = 'insufficient_privilege';
  end if;

  select id into demo_id from events where is_demo limit 1;

  if demo_id is null then
    raise exception 'There is no demo outing.' using errcode = 'no_data_found';
  end if;

  delete from event_scores where event_id = demo_id;
  get diagnostics removed = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_scores', 'event', demo_id::text,
          jsonb_build_object('removed', removed));

  return removed;
end;
$fn$;

-- --------------------------------------------------------------- grants

-- CREATE FUNCTION grants EXECUTE to PUBLIC, and Supabase's default privileges
-- add anon on top; both have to be taken away by name.
revoke execute on function owner_league_overview() from public, anon;
revoke execute on function owner_clear_round_scores(uuid) from public, anon;
revoke execute on function owner_clear_round_feed(uuid) from public, anon;
revoke execute on function owner_update_round(uuid, text, date, text) from public, anon;
revoke execute on function owner_start_new_week(text, date) from public, anon;
revoke execute on function owner_set_admin(uuid, boolean) from public, anon;
revoke execute on function owner_remove_player(uuid) from public, anon;
revoke execute on function admin_clear_demo_scores() from public, anon;

grant execute on function owner_league_overview() to authenticated;
grant execute on function owner_clear_round_scores(uuid) to authenticated;
grant execute on function owner_clear_round_feed(uuid) to authenticated;
grant execute on function owner_update_round(uuid, text, date, text) to authenticated;
grant execute on function owner_start_new_week(text, date) to authenticated;
grant execute on function owner_set_admin(uuid, boolean) to authenticated;
grant execute on function owner_remove_player(uuid) to authenticated;
grant execute on function admin_clear_demo_scores() to authenticated;
