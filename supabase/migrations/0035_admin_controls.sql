/*
  More control for the admin and the owner, and guests.

  - League defaults for the first tee time and the gap between groups, and a
    re-time action that respaces a week's existing groups.
  - An announcement banner any admin can post on the league page.
  - The owner can correct any player's name and phone, and merge a duplicate
    account into the real one.
  - Clearing a week's scores keeps a copy for seven days, so a mis-click can
    be put back.
  - Guest players: a name, no account, placed in a group for a week.
*/

-- ------------------------------------------------------------------ guests

/*
  A guest is a profile with no login behind it. profiles.id used to be a
  foreign key to auth.users, which made that impossible, so the key goes and a
  trigger takes over its one job: when a login is deleted, its profile goes
  with it, exactly as the cascade did.
*/
do $$
declare
  fk text;
begin
  select conname into fk
    from pg_constraint
   where conrelid = 'public.profiles'::regclass
     and contype = 'f'
     and confrelid = 'auth.users'::regclass;

  if fk is not null then
    execute format('alter table public.profiles drop constraint %I', fk);
  end if;
end;
$$;

alter table profiles add column if not exists is_guest boolean not null default false;

create or replace function remove_deleted_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  delete from profiles where id = old.id;
  return old;
end;
$fn$;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function remove_deleted_user_profile();

/*
  Add a guest and seat them in a group, which also rebuilds that group's
  scoring ring so somebody keeps the guest's card. A guest who has played
  before is already in the list and is placed like anyone else.
*/
create or replace function admin_add_guest(
  in_round_id    uuid,
  in_tee_time_id uuid,
  in_name        text,
  in_handicap    numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  guest uuid := gen_random_uuid();
  clean text := btrim(coalesce(in_name, ''));
begin
  if not is_admin() then
    raise exception 'Only an admin can add a guest.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(clean) not between 2 and 80 then
    raise exception 'Give the guest a name.' using errcode = 'check_violation';
  end if;

  if in_handicap is not null and (in_handicap < -10 or in_handicap > 54) then
    raise exception 'A handicap index runs from +10 to 54.'
      using errcode = 'check_violation';
  end if;

  insert into profiles (id, full_name, handicap_index, is_guest)
  values (guest, clean, round(in_handicap, 1), true);

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'guest', guest::text,
          jsonb_build_object('name', clean, 'round_id', in_round_id));

  if in_tee_time_id is not null then
    perform admin_place_player(in_round_id, guest, in_tee_time_id);
  end if;

  return guest;
end;
$fn$;

/*
  The groups editor, now marking guests. A guest never answers an RSVP, so
  they don't count towards "no answer" either.
*/
create or replace function admin_week_groups(in_round_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  week rounds%rowtype;
begin
  if not is_admin() then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'round', jsonb_build_object(
      'id',         week.id,
      'name',       week.name,
      'playedOn',   week.played_on,
      'status',     week.status,
      'rsvpLockAt', week.rsvp_lock_at,
      'hasScores',  exists (select 1 from scores where round_id = week.id)
    ),

    'groups', coalesce((
      select jsonb_agg(g.entry order by g.tee_at, g.id)
        from (
          select t.tee_at,
                 t.id,
                 jsonb_build_object(
                   'id',     t.id,
                   'teeAt',  t.tee_at,
                   'players', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',       ttp.player_id,
                                'name',     p.full_name,
                                'position', ttp.position,
                                'isGuest',  p.is_guest,
                                -- Who keeps this player's card, so the ring is visible.
                                'keptBy',   (
                                  select k.full_name
                                    from scorer_assignments sa
                                    join profiles k on k.id = sa.scorer_player_id
                                   where sa.tee_time_id = t.id
                                     and sa.scored_player_id = ttp.player_id
                                )
                              ) order by ttp.position
                            )
                       from tee_time_players ttp
                       join profiles p on p.id = ttp.player_id
                      where ttp.tee_time_id = t.id
                   ), '[]'::jsonb)
                 ) as entry
            from tee_times t
           where t.round_id = week.id
        ) as g
    ), '[]'::jsonb),

    -- Everyone not in a group this week, with their answer; guests last.
    'others', coalesce((
      select jsonb_agg(o.entry order by o.rank, o.name)
        from (
          select p.full_name as name,
                 case when p.is_guest then 4
                      else case r.status when 'in' then 0 when 'undecided' then 2
                                         when 'out' then 3 else 1 end
                 end as rank,
                 jsonb_build_object(
                   'id',               p.id,
                   'name',             p.full_name,
                   'rsvp',             r.status,
                   'preferredTeeTime', p.preferred_tee_time,
                   'isGuest',          p.is_guest
                 ) as entry
            from profiles p
            left join round_rsvps r on r.round_id = week.id and r.player_id = p.id
           where not exists (
             select 1 from tee_time_players ttp
              where ttp.round_id = week.id and ttp.player_id = p.id
           )
        ) as o
    ), '[]'::jsonb),

    'rsvp', jsonb_build_object(
      'in',        (select count(*) from round_rsvps where round_id = week.id and status = 'in'),
      'out',       (select count(*) from round_rsvps where round_id = week.id and status = 'out'),
      'undecided', (select count(*) from round_rsvps where round_id = week.id and status = 'undecided'),
      'noAnswer',  (select count(*) from profiles p
                     where not p.is_guest
                       and not exists (select 1 from round_rsvps r
                                        where r.round_id = week.id and r.player_id = p.id))
    )
  );
end;
$fn$;

/*
  Removing a player: as before, and now a guest too. A guest has no login to
  delete, so the profile is deleted directly; for everyone else the login's
  deletion takes the profile with it through on_auth_user_deleted.
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

  delete from auth.users where id = in_profile_id;
  delete from profiles where id = in_profile_id;

  foreach t in array affected loop
    perform rebuild_scoring_ring(t);
  end loop;
end;
$fn$;

-- ------------------------------------------------------------- tee times

alter table league_settings
  add column if not exists first_tee_time       time not null default '08:00',
  add column if not exists tee_interval_minutes smallint not null default 10
    check (tee_interval_minutes between 5 and 30);

create or replace function admin_set_tee_defaults(in_first_tee time, in_interval integer)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_admin() then
    raise exception 'Only an admin can change the tee time defaults.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_first_tee is null then
    raise exception 'Pick the first tee time.' using errcode = 'check_violation';
  end if;

  if in_interval is null or in_interval not between 5 and 30 then
    raise exception 'Tee times go 5 to 30 minutes apart.'
      using errcode = 'check_violation';
  end if;

  update league_settings
     set first_tee_time = in_first_tee,
         tee_interval_minutes = in_interval,
         updated_at = now();

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_settings', 'tee_defaults',
          jsonb_build_object('first_tee', in_first_tee, 'interval', in_interval));
end;
$fn$;

/*
  Respace a week's groups from a first tee time, keeping their order. For the
  groups a copied week carried over at the wrong time, or a course that moved
  the league's slot.
*/
create or replace function admin_retime_groups(
  in_round_id         uuid,
  in_first_tee        timestamptz,
  in_interval_minutes integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  moved integer;
begin
  if not is_admin() then
    raise exception 'Only an admin can change tee times.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from rounds where id = in_round_id) then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if in_first_tee is null then
    raise exception 'Pick the first tee time.' using errcode = 'check_violation';
  end if;

  if in_interval_minutes is null or in_interval_minutes not between 5 and 30 then
    raise exception 'Tee times go 5 to 30 minutes apart.'
      using errcode = 'check_violation';
  end if;

  -- row_number() is a bigint, and make_interval takes an integer.
  update tee_times t
     set tee_at = in_first_tee + make_interval(mins => ((o.n - 1) * in_interval_minutes)::integer)
    from (
      select id, row_number() over (order by tee_at, id) as n
        from tee_times where round_id = in_round_id
    ) as o
   where t.id = o.id;

  get diagnostics moved = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'retime_groups', 'round', in_round_id::text,
          jsonb_build_object('first_tee', in_first_tee, 'interval', in_interval_minutes,
                             'groups', moved));

  return moved;
end;
$fn$;

-- ---------------------------------------------------------- announcement

alter table league_settings
  add column if not exists announcement    text,
  add column if not exists announcement_at timestamptz;

/* Any admin, not just the owner: a rain delay is news whoever hears it first. */
create or replace function admin_set_announcement(in_text text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  clean text := nullif(btrim(coalesce(in_text, '')), '');
begin
  if not is_admin() then
    raise exception 'Only an admin can post an announcement.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(clean) > 500 then
    raise exception 'Keep it under 500 characters.' using errcode = 'check_violation';
  end if;

  update league_settings
     set announcement = clean,
         announcement_at = case when clean is null then null else now() end,
         updated_at = now();

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), case when clean is null then 'delete' else 'update' end,
          'announcement', 'league', jsonb_build_object('text', clean));
end;
$fn$;

-- ------------------------------------------------------------ players

/*
  Correct a player's name, and their phone. For an account that signs in by
  phone the number is the login, so it changes there and sync_user_phone
  carries it to the profile; a guest's is just the profile's.
*/
create or replace function owner_update_player(
  in_profile_id uuid,
  in_full_name  text,
  in_phone      text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  clean   text := btrim(coalesce(in_full_name, ''));
  wanted  text := nullif(btrim(coalesce(in_phone, '')), '');
  holder  text;
  before  profiles%rowtype;
begin
  if not is_owner() then
    raise exception 'Only the league owner can edit a player.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into before from profiles where id = in_profile_id;

  if before.id is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  if length(clean) not between 2 and 80 then
    raise exception 'Enter a first and last name.' using errcode = 'check_violation';
  end if;

  if wanted is not null and wanted !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'Enter a 10-digit US mobile number.' using errcode = 'check_violation';
  end if;

  if wanted is not null and wanted is distinct from before.phone then
    select p.full_name into holder
      from profiles p
     where p.id <> in_profile_id
       and (p.phone = wanted
            or exists (select 1 from auth.users u
                        where u.id = p.id and u.phone = ltrim(wanted, '+')));

    if holder is not null then
      raise exception '% already uses that number.', holder
        using errcode = 'unique_violation';
    end if;

    if exists (select 1 from auth.users where id = in_profile_id) then
      update auth.users set phone = ltrim(wanted, '+') where id = in_profile_id;
    end if;

    update profiles set phone = wanted where id = in_profile_id;
  end if;

  update profiles set full_name = clean where id = in_profile_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'player', in_profile_id::text,
          jsonb_build_object('from', jsonb_build_object('name', before.full_name, 'phone', before.phone),
                             'to', jsonb_build_object('name', clean,
                                                      'phone', coalesce(wanted, before.phone))));
end;
$fn$;

/*
  Fold a duplicate account into the real one.

  Everything the removed account owns moves across. Where both hold the same
  thing — a score for the same hole, an answer for the same week, a place in
  the same week's groups — the kept account's stands. The removed login is
  deleted; if the kept account had no phone login, it takes the removed one's
  number, so the person can sign in either way afterwards.
*/
create or replace function owner_merge_players(in_keep uuid, in_remove uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kept           profiles%rowtype;
  gone           profiles%rowtype;
  gone_phone     text;
  gone_confirmed timestamptz;
  affected       uuid[];
  t              uuid;
begin
  if not is_owner() then
    raise exception 'Only the league owner can merge players.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_keep is null or in_remove is null or in_keep = in_remove then
    raise exception 'Pick two different players.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from league_owner where profile_id = in_remove) then
    raise exception 'The owner''s account can''t be merged away. Merge the other one into it instead.'
      using errcode = 'check_violation';
  end if;

  select * into kept from profiles where id = in_keep;
  select * into gone from profiles where id = in_remove;

  if kept.id is null or gone.id is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  -- Groups the removed account sits in; their scoring rings are redone below.
  select coalesce(array_agg(distinct tee_time_id), '{}') into affected
    from tee_time_players where player_id = in_remove;

  -- Scores.
  delete from scores s
   where s.player_id = in_remove
     and exists (select 1 from scores k
                  where k.player_id = in_keep and k.round_id = s.round_id and k.hole = s.hole);
  update scores set player_id = in_keep where player_id = in_remove;
  update scores set entered_by = in_keep where entered_by = in_remove;

  delete from cleared_scores c
   where c.player_id = in_remove
     and exists (select 1 from cleared_scores k
                  where k.batch = c.batch and k.player_id = in_keep and k.hole = c.hole);
  update cleared_scores set player_id = in_keep where player_id = in_remove;
  update cleared_scores set entered_by = in_keep where entered_by = in_remove;

  -- Groups: one place per player per week.
  delete from scorer_assignments
   where scored_player_id = in_remove or scorer_player_id = in_remove;
  delete from tee_time_players g
   where g.player_id = in_remove
     and exists (select 1 from tee_time_players k
                  where k.round_id = g.round_id and k.player_id = in_keep);
  update tee_time_players set player_id = in_keep where player_id = in_remove;

  -- Answers and requests: one per player per week or tournament.
  delete from round_rsvps r
   where r.player_id = in_remove
     and exists (select 1 from round_rsvps k where k.round_id = r.round_id and k.player_id = in_keep);
  update round_rsvps set player_id = in_keep where player_id = in_remove;
  update round_rsvps set set_by = in_keep where set_by = in_remove;

  delete from tee_time_requests r
   where r.player_id = in_remove
     and exists (select 1 from tee_time_requests k where k.round_id = r.round_id and k.player_id = in_keep);
  update tee_time_requests set player_id = in_keep where player_id = in_remove;

  delete from tournament_rsvps r
   where r.player_id = in_remove
     and exists (select 1 from tournament_rsvps k
                  where k.tournament_id = r.tournament_id and k.player_id = in_keep);
  update tournament_rsvps set player_id = in_keep where player_id = in_remove;
  update tournament_rsvps set set_by = in_keep where set_by = in_remove;

  delete from tournament_results r
   where r.player_id = in_remove
     and exists (select 1 from tournament_results k
                  where k.tournament_id = r.tournament_id and k.player_id = in_keep);
  update tournament_results set player_id = in_keep where player_id = in_remove;

  -- Things they made.
  update feed_posts    set author_id  = in_keep where author_id  = in_remove;
  update events        set created_by = in_keep where created_by = in_remove;
  update tournaments   set created_by = in_keep where created_by = in_remove;
  update client_errors set user_id    = in_keep where user_id    = in_remove;

  select phone, phone_confirmed_at into gone_phone, gone_confirmed
    from auth.users where id = in_remove;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'merge', 'player', in_keep::text,
          jsonb_build_object('kept', kept.full_name, 'removed', gone.full_name,
                             'removed_id', in_remove));

  -- The login goes, and on_auth_user_deleted takes the profile; a guest has
  -- no login, so its profile is deleted directly.
  delete from auth.users where id = in_remove;
  delete from profiles where id = in_remove;

  if coalesce(gone_phone, '') <> ''
     and exists (select 1 from auth.users where id = in_keep and coalesce(phone, '') = '') then
    update auth.users
       set phone = gone_phone, phone_confirmed_at = gone_confirmed
     where id = in_keep;
  end if;

  -- The kept profile takes whatever it was missing.
  update profiles
     set phone              = coalesce(phone, gone.phone),
         handicap_index     = coalesce(handicap_index, gone.handicap_index),
         preferred_tee      = coalesce(preferred_tee, gone.preferred_tee),
         preferred_tee_time = coalesce(preferred_tee_time, gone.preferred_tee_time),
         is_admin           = is_admin or gone.is_admin
   where id = in_keep;

  foreach t in array affected loop
    perform rebuild_scoring_ring(t);
  end loop;
end;
$fn$;

-- --------------------------------------------------------- undo a clear

/*
  What owner_clear_round_scores took, kept for seven days. No policies: only
  the owner functions below read or write it.
*/
create table if not exists cleared_scores (
  id         bigserial primary key,
  batch      uuid not null,
  round_id   uuid not null references rounds on delete cascade,
  player_id  uuid not null references profiles on delete cascade,
  hole       smallint not null,
  strokes    smallint not null,
  entered_by uuid,
  cleared_at timestamptz not null default now()
);

alter table cleared_scores enable row level security;

create or replace function owner_clear_round_scores(in_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed    integer;
  round_name text;
  batch_id   uuid := gen_random_uuid();
begin
  if not is_owner() then
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

  update rounds set status = 'live' where id = in_round_id and status = 'final';

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_scores', 'round', in_round_id::text,
          jsonb_build_object('name', round_name, 'removed', removed, 'batch', batch_id));

  return removed;
end;
$fn$;

/* The weeks whose last clear can still be undone. */
create or replace function owner_restorable_scores()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can see cleared scores.'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'roundId',   l.round_id,
             'count',     l.n,
             'clearedAt', l.cleared_at))
      from (
        select distinct on (c.round_id) c.round_id, c.batch, c.cleared_at,
               count(*) over (partition by c.batch) as n
          from cleared_scores c
         where c.cleared_at >= now() - interval '7 days'
         order by c.round_id, c.cleared_at desc
      ) as l
     where not exists (select 1 from scores s where s.round_id = l.round_id)
  ), '[]'::jsonb);
end;
$fn$;

/*
  Put a week's last cleared scores back. Refused once the week has new scores,
  rather than mixing two rounds on one card.
*/
create or replace function owner_restore_scores(in_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  batch_id uuid;
  restored integer;
begin
  if not is_owner() then
    raise exception 'Only the league owner can restore scores.'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from scores where round_id = in_round_id) then
    raise exception 'This week has new scores since it was cleared, so the old ones can''t come back.'
      using errcode = 'check_violation';
  end if;

  select batch into batch_id
    from cleared_scores
   where round_id = in_round_id and cleared_at >= now() - interval '7 days'
   order by cleared_at desc
   limit 1;

  if batch_id is null then
    raise exception 'There''s nothing cleared from this week to put back.'
      using errcode = 'no_data_found';
  end if;

  -- Hole order, so the sequential-entry rule is satisfied as they go in.
  insert into scores (round_id, player_id, hole, strokes, entered_by)
  select c.round_id, c.player_id, c.hole, c.strokes,
         case when exists (select 1 from profiles p where p.id = c.entered_by)
              then c.entered_by else auth.uid() end
    from cleared_scores c
   where c.batch = batch_id
     and exists (select 1 from profiles p where p.id = c.player_id)
   order by c.player_id, c.hole;

  get diagnostics restored = row_count;

  delete from cleared_scores where batch = batch_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'restore_scores', 'round', in_round_id::text,
          jsonb_build_object('restored', restored, 'batch', batch_id));

  return restored;
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function remove_deleted_user_profile() from public, anon, authenticated;

revoke execute on function admin_add_guest(uuid, uuid, text, numeric) from public, anon;
revoke execute on function admin_set_tee_defaults(time, integer) from public, anon;
revoke execute on function admin_retime_groups(uuid, timestamptz, integer) from public, anon;
revoke execute on function admin_set_announcement(text) from public, anon;
revoke execute on function owner_update_player(uuid, text, text) from public, anon;
revoke execute on function owner_merge_players(uuid, uuid) from public, anon;
revoke execute on function owner_restorable_scores() from public, anon;
revoke execute on function owner_restore_scores(uuid) from public, anon;

grant execute on function admin_add_guest(uuid, uuid, text, numeric) to authenticated;
grant execute on function admin_set_tee_defaults(time, integer) to authenticated;
grant execute on function admin_retime_groups(uuid, timestamptz, integer) to authenticated;
grant execute on function admin_set_announcement(text) to authenticated;
grant execute on function owner_update_player(uuid, text, text) to authenticated;
grant execute on function owner_merge_players(uuid, uuid) to authenticated;
grant execute on function owner_restorable_scores() to authenticated;
grant execute on function owner_restore_scores(uuid) to authenticated;
