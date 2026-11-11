/*
  Running a club: who is in it, as what, in which league, and how people get
  in. And the platform admin's view across clubs.

  Everything a club admin does here is one function that checks the caller is
  an admin of that club, writes, and records it in the audit log. Nothing here
  reaches across clubs: a club admin adds people to their own club, places
  them in their own leagues, and can't see or change anyone else's members.

  Joining works the way the pro shop asked for it:

    a player scans the club's QR code or opens its link, signs up or signs in,
    and asks to join (club_request_join). The request waits on the club's
    admins, who approve or decline it (club_decide). An admin can also add
    somebody directly by their phone number (club_add_member), as long as they
    have an account. Inside a club, a player can ask for a league
    (league_request_join), but the admin is who puts them in one
    (league_set_member).

  New accounts no longer join PukaGolf by themselves. Until now that kept
  PukaGolf's signup working while there was no other way in; now there is,
  and PukaGolf's players join through PukaGolf's link like any club's.

  Roles: an admin runs the club; staff see the whole club and fix scores only
  when an admin switches that on for them; a player plays. A club always keeps
  at least one admin.

  Request limits: an account can ask to join at most 10 clubs a day, and a
  player an admin removed can't ask again for 7 days, so a link passed around
  can't be used to flood a pro shop with requests.

  Pausing a club, so its members can look but not change anything, is not
  here yet: closing one (hiding it from its members) is. Pausing needs every
  write to ask whether the club is open, and is its own change.
*/

-- ------------------------------------------------------------ helpers

/*
  A US mobile number as profiles store it, from however an admin typed it:
  "(555) 555-0100", "555.555.0100", "+1 555 555 0100". Null if it isn't one.
*/
create or replace function us_phone(raw text)
returns text
language sql
immutable
as $fn$
  select case
    when length(d) = 10 then '+1' || d
    when length(d) = 11 and left(d, 1) = '1' then '+' || d
  end
    from (select regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g') as d) as digits;
$fn$;

-- The account behind a phone number, if anyone has signed up with it.
create or replace function profile_for_phone(in_phone text)
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select p.id
    from profiles p
   where p.phone = us_phone(in_phone)
      or exists (select 1 from auth.users u
                  where u.id = p.id and u.phone = ltrim(us_phone(in_phone), '+'))
   order by p.created_at
   limit 1;
$fn$;

-- One place for "only an admin of this club", with the same words everywhere.
create or replace function assert_club_admin(in_club_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if in_club_id is null or not is_club_admin(in_club_id) then
    raise exception 'Only an admin of this club can do that.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$fn$;

/*
  PukaGolf's admins are also marked on profiles, because the app still reads
  profiles.is_admin for PukaGolf's own pages (outings, the owner's admin
  page). Kept in step wherever a PukaGolf role changes.
*/
create or replace function sync_pukagolf_admin(in_club_id uuid, in_profile_id uuid)
returns void
language sql
security definer
set search_path = public
as $fn$
  update profiles
     set is_admin = exists (
           select 1 from club_members
            where club_id = 'a0000000-0000-4000-8000-000000000001'
              and profile_id = in_profile_id
              and role = 'admin' and status = 'active')
   where id = in_profile_id
     and in_club_id = 'a0000000-0000-4000-8000-000000000001';
$fn$;

-- ------------------------------------------------------------ new accounts

/*
  A new account is just a person. Which club they belong to is decided by
  the club, through a request or an admin adding them.
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

-- ------------------------------------------------------------ joining

/*
  Ask to join a club, by its address. Returns where that leaves the caller:
  'requested', or 'member' if they already are one.
*/
create or replace function club_request_join(in_slug text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me     uuid := auth.uid();
  target clubs%rowtype;
  mine   club_members%rowtype;
  today  integer;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  select * into target from clubs where slug = lower(btrim(in_slug));

  if target.id is null or target.status = 'closed' then
    raise exception 'There''s no club at that address.' using errcode = 'no_data_found';
  end if;

  if target.status <> 'active' then
    raise exception '% isn''t taking new members right now.', target.name
      using errcode = 'check_violation';
  end if;

  select * into mine from club_members where club_id = target.id and profile_id = me;

  if mine.status = 'active' then
    return 'member';
  end if;

  if mine.status = 'requested' then
    return 'requested';
  end if;

  if mine.status = 'removed' and mine.decided_at > now() - interval '7 days' then
    raise exception 'You can ask to join % again after %.',
      target.name, to_char(mine.decided_at + interval '7 days', 'FMMonth FMDD')
      using errcode = 'check_violation';
  end if;

  select count(*) into today
    from club_members
   where profile_id = me and status = 'requested' and requested_at > now() - interval '1 day';

  if today >= 10 then
    raise exception 'That''s a lot of clubs for one day. Try again tomorrow.'
      using errcode = 'check_violation';
  end if;

  insert into club_members (club_id, profile_id, role, status, requested_at, decided_at, decided_by)
  values (target.id, me, 'player', 'requested', now(), null, null)
  on conflict (club_id, profile_id) do update
    set role = 'player', status = 'requested', staff_can_edit_scores = false,
        requested_at = now(), decided_at = null, decided_by = null;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (me, 'request', 'club_member', target.id::text,
          jsonb_build_object('club', target.slug));

  return 'requested';
end;
$fn$;

-- Approve a request (they become a player) or decline it.
create or replace function club_decide(in_club_id uuid, in_profile_id uuid, in_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(in_club_id);

  update club_members
     set status = case when in_approve then 'active' else 'removed' end,
         role = 'player',
         decided_at = now(),
         decided_by = auth.uid()
   where club_id = in_club_id and profile_id = in_profile_id and status = 'requested';

  if not found then
    raise exception 'There''s no request from them waiting.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), case when in_approve then 'approve' else 'decline' end,
          'club_member', in_profile_id::text, jsonb_build_object('club_id', in_club_id));
end;
$fn$;

/*
  Add somebody straight in, by the number they signed up with. Only people
  with an account: the account is theirs to make, with their own password.
*/
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

  who := profile_for_phone(in_phone);

  if who is null then
    raise exception 'Nobody has signed up with that number yet. Send them the club''s link so they can.'
      using errcode = 'no_data_found';
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

-- ------------------------------------------------------------ roles

/*
  A club always keeps an admin: nobody can demote or remove the last one,
  themselves included, or the club would be left with nobody able to run it.
*/
create or replace function assert_keeps_an_admin(in_club_id uuid, in_profile_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if exists (select 1 from club_members
              where club_id = in_club_id and profile_id = in_profile_id
                and role = 'admin' and status = 'active')
     and not exists (select 1 from club_members
                      where club_id = in_club_id and profile_id <> in_profile_id
                        and role = 'admin' and status = 'active') then
    raise exception 'A club needs at least one admin. Make someone else an admin first.'
      using errcode = 'check_violation';
  end if;
end;
$fn$;

create or replace function club_set_role(in_club_id uuid, in_profile_id uuid, in_role text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(in_club_id);

  if in_role not in ('admin', 'staff', 'player') then
    raise exception 'A member is an admin, staff or a player.' using errcode = 'check_violation';
  end if;

  if in_role <> 'admin' then
    perform assert_keeps_an_admin(in_club_id, in_profile_id);
  end if;

  update club_members
     set role = in_role,
         -- Fixing scores is a setting on staff; any other role starts without it.
         staff_can_edit_scores = case when in_role = 'staff' then staff_can_edit_scores else false end
   where club_id = in_club_id and profile_id = in_profile_id and status = 'active';

  if not found then
    raise exception 'They aren''t a member of this club.' using errcode = 'no_data_found';
  end if;

  perform sync_pukagolf_admin(in_club_id, in_profile_id);

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'club_member', in_profile_id::text,
          jsonb_build_object('club_id', in_club_id, 'role', in_role));
end;
$fn$;

-- The club admin's switch for one staff member: may they fix scores?
create or replace function club_set_staff_scores(in_club_id uuid, in_profile_id uuid, in_allowed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(in_club_id);

  update club_members
     set staff_can_edit_scores = coalesce(in_allowed, false)
   where club_id = in_club_id and profile_id = in_profile_id
     and status = 'active' and role = 'staff';

  if not found then
    raise exception 'Only staff have this setting.' using errcode = 'check_violation';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'club_member', in_profile_id::text,
          jsonb_build_object('club_id', in_club_id, 'staff_can_edit_scores', coalesce(in_allowed, false)));
end;
$fn$;

/*
  Remove somebody from this club, and so from its leagues. Their account, and
  their scores here and anywhere else, stay: removing a member is not deleting
  a person, which only the platform admin does.
*/
create or replace function club_remove_member(in_club_id uuid, in_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(in_club_id);
  perform assert_keeps_an_admin(in_club_id, in_profile_id);

  update club_members
     set status = 'removed', role = 'player', staff_can_edit_scores = false,
         decided_at = now(), decided_by = auth.uid()
   where club_id = in_club_id and profile_id = in_profile_id and status <> 'removed';

  if not found then
    raise exception 'They aren''t a member of this club.' using errcode = 'no_data_found';
  end if;

  update league_members lm
     set status = 'removed', decided_at = now(), decided_by = auth.uid()
    from leagues l
   where l.id = lm.league_id and l.club_id = in_club_id
     and lm.profile_id = in_profile_id and lm.status <> 'removed';

  perform sync_pukagolf_admin(in_club_id, in_profile_id);

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'remove', 'club_member', in_profile_id::text,
          jsonb_build_object('club_id', in_club_id));
end;
$fn$;

-- ------------------------------------------------------------ leagues

/*
  A new league in the club. It starts as the standard league: singles,
  stroke play, gross, nothing else; its own rules come with per-league rules.
  The address part is made from the name, kept unique within the club.
*/
create or replace function league_create(in_club_id uuid, in_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  clean text := btrim(coalesce(in_name, ''));
  base  text;
  new_slug text;
  n     integer := 1;
  fresh uuid;
begin
  perform assert_club_admin(in_club_id);

  if length(clean) not between 2 and 80 then
    raise exception 'Give the league a name.' using errcode = 'check_violation';
  end if;

  base := trim(both '-' from regexp_replace(lower(clean), '[^a-z0-9]+', '-', 'g'));
  if length(base) < 2 then
    base := 'league';
  end if;
  base := left(base, 36);
  new_slug := base;

  while exists (select 1 from leagues l where l.club_id = in_club_id and l.slug = new_slug) loop
    n := n + 1;
    new_slug := base || '-' || n;
  end loop;

  insert into leagues (club_id, slug, name)
  values (in_club_id, new_slug, clean)
  returning id into fresh;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'league', fresh::text,
          jsonb_build_object('club_id', in_club_id, 'name', clean));

  return fresh;
end;
$fn$;

-- Ask to play in a league of a club the caller already belongs to.
create or replace function league_request_join(in_league_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me    uuid := auth.uid();
  club  uuid := league_club(in_league_id);
  mine  league_members%rowtype;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if club is null or not exists (select 1 from club_members
                                   where club_id = club and profile_id = me and status = 'active') then
    raise exception 'Join the club first.' using errcode = 'insufficient_privilege';
  end if;

  select * into mine from league_members where league_id = in_league_id and profile_id = me;

  if mine.status = 'active' then
    return 'member';
  end if;

  if mine.status = 'requested' then
    return 'requested';
  end if;

  insert into league_members (league_id, profile_id, status, requested_at, decided_at, decided_by)
  values (in_league_id, me, 'requested', now(), null, null)
  on conflict (league_id, profile_id) do update
    set status = 'requested', requested_at = now(), decided_at = null, decided_by = null;

  return 'requested';
end;
$fn$;

/*
  Put a member in a league, or take them out: the pro shop decides who plays
  where. Only active members of the club can be placed.
*/
create or replace function league_set_member(in_league_id uuid, in_profile_id uuid, in_playing boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  club uuid := league_club(in_league_id);
begin
  perform assert_club_admin(club);

  if in_playing then
    if not exists (select 1 from club_members
                    where club_id = club and profile_id = in_profile_id and status = 'active') then
      raise exception 'Only members of the club can play in its leagues.'
        using errcode = 'check_violation';
    end if;

    insert into league_members (league_id, profile_id, status, requested_at, decided_at, decided_by)
    values (in_league_id, in_profile_id, 'active', now(), now(), auth.uid())
    on conflict (league_id, profile_id) do update
      set status = 'active', decided_at = now(), decided_by = auth.uid();
  else
    update league_members
       set status = 'removed', decided_at = now(), decided_by = auth.uid()
     where league_id = in_league_id and profile_id = in_profile_id and status <> 'removed';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), case when in_playing then 'place' else 'unplace' end,
          'league_member', in_profile_id::text, jsonb_build_object('league_id', in_league_id));
end;
$fn$;

-- ------------------------------------------------------------ the admin page

/*
  Everything a club admin's page shows, in one call: the club, its leagues and
  who is in each, and every member and request with what an admin needs to
  decide (name, number, handicap). Phone numbers are here because an admin
  adding or checking a member needs them; nowhere else shows them across a
  club.
*/
create or replace function club_admin_overview(in_club_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform assert_club_admin(in_club_id);

  return jsonb_build_object(
    'club', (select jsonb_build_object('id', id, 'slug', slug, 'name', name,
                                       'status', status, 'isDemo', is_demo)
               from clubs where id = in_club_id),

    'leagues', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'slug', l.slug, 'name', l.name, 'status', l.status,
               'playing', coalesce((select jsonb_agg(lm.profile_id) from league_members lm
                                     where lm.league_id = l.id and lm.status = 'active'), '[]'::jsonb),
               'asking',  coalesce((select jsonb_agg(lm.profile_id) from league_members lm
                                     where lm.league_id = l.id and lm.status = 'requested'), '[]'::jsonb)
             ) order by l.name)
        from leagues l where l.club_id = in_club_id
    ), '[]'::jsonb),

    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'name', p.full_name,
               'phone', p.phone,
               'handicapIndex', p.handicap_index,
               'isGuest', p.is_guest,
               'role', m.role,
               'status', m.status,
               'staffCanFixScores', m.staff_can_edit_scores,
               'requestedAt', m.requested_at,
               'decidedAt', m.decided_at
             ) order by m.status = 'requested' desc, p.full_name)
        from club_members m
        join profiles p on p.id = m.profile_id
       where m.club_id = in_club_id and m.status in ('active', 'requested')
    ), '[]'::jsonb)
  );
end;
$fn$;

-- ------------------------------------------------------------ the platform admin

-- Every club, with enough to see at a glance which are alive.
create or replace function platform_clubs()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not is_platform_admin() then
    raise exception 'Only the platform admin can see every club.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id,
             'slug', c.slug,
             'name', c.name,
             'status', c.status,
             'isDemo', c.is_demo,
             'createdAt', c.created_at,
             'members', (select count(*) from club_members m
                          where m.club_id = c.id and m.status = 'active'),
             'requests', (select count(*) from club_members m
                           where m.club_id = c.id and m.status = 'requested'),
             'leagues', (select count(*) from leagues l where l.club_id = c.id),
             'admins', coalesce((select jsonb_agg(p.full_name order by p.full_name)
                                   from club_members m join profiles p on p.id = m.profile_id
                                  where m.club_id = c.id and m.role = 'admin' and m.status = 'active'),
                                '[]'::jsonb),
             'lastPlayed', (select max(r.played_on) from rounds r
                              join leagues l on l.id = r.league_id where l.club_id = c.id)
           ) order by c.name)
      from clubs c
  ), '[]'::jsonb);
end;
$fn$;

/*
  A new club, with its first league, and its first admin if their number is
  given and they have an account (otherwise added later, once they sign up).
*/
create or replace function platform_create_club(in_slug text, in_name text, in_is_demo boolean default false,
                                                in_admin_phone text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  clean_name text := btrim(coalesce(in_name, ''));
  clean_slug text := lower(btrim(coalesce(in_slug, '')));
  fresh      uuid;
  who        uuid;
begin
  if not is_platform_admin() then
    raise exception 'Only the platform admin can create a club.' using errcode = 'insufficient_privilege';
  end if;

  if length(clean_name) not between 1 and 80 then
    raise exception 'Give the club a name.' using errcode = 'check_violation';
  end if;

  if clean_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(clean_slug) not between 2 and 40 then
    raise exception 'The address is lowercase letters, numbers and dashes, like moose-ridge.'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from clubs where slug = clean_slug) then
    raise exception 'Another club already uses /c/%.', clean_slug using errcode = 'unique_violation';
  end if;

  if nullif(btrim(coalesce(in_admin_phone, '')), '') is not null then
    who := profile_for_phone(in_admin_phone);
    if who is null then
      raise exception 'Nobody has signed up with that number yet. Create the club without an admin and add them once they have.'
        using errcode = 'no_data_found';
    end if;
  end if;

  insert into clubs (slug, name, is_demo)
  values (clean_slug, clean_name, coalesce(in_is_demo, false))
  returning id into fresh;

  insert into leagues (club_id, slug, name) values (fresh, 'league', 'League');

  if who is not null then
    insert into club_members (club_id, profile_id, role, status, decided_at, decided_by)
    values (fresh, who, 'admin', 'active', now(), auth.uid());
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'club', fresh::text,
          jsonb_build_object('slug', clean_slug, 'name', clean_name, 'admin', who));

  return fresh;
end;
$fn$;

-- Close a club (hidden from its members, nothing deleted) or reopen it.
create or replace function platform_set_club_status(in_club_id uuid, in_status text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_platform_admin() then
    raise exception 'Only the platform admin can open or close a club.' using errcode = 'insufficient_privilege';
  end if;

  if in_status not in ('active', 'closed') then
    raise exception 'A club is open or closed.' using errcode = 'check_violation';
  end if;

  update clubs set status = in_status, updated_at = now() where id = in_club_id;

  if not found then
    raise exception 'No such club.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'club', in_club_id::text, jsonb_build_object('status', in_status));
end;
$fn$;

/*
  The platform admin looking at a club they aren't a member of, written down,
  so a club can always see when its data was looked at from outside.
*/
create or replace function platform_note_view(in_club_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_platform_admin() or club_role(in_club_id) is not null then
    return;
  end if;

  -- Once an hour per club is a record; every page load would be noise.
  if exists (select 1 from audit_log
              where actor_id = auth.uid() and action = 'view' and entity = 'club'
                and entity_id = in_club_id::text and at > now() - interval '1 hour') then
    return;
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'view', 'club', in_club_id::text, '{}'::jsonb);
end;
$fn$;

-- ------------------------------------------------------------ my clubs, revisited

/*
  As in 0048, plus whether the caller's admin role in a club comes only from
  being the platform admin, so the page can note the visit and say so.
*/
create or replace function my_clubs()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(x.club order by x.name), '[]'::jsonb)
    from (
      select cl.name,
             jsonb_build_object(
               'id',     cl.id,
               'slug',   cl.slug,
               'name',   cl.name,
               'status', cl.status,
               'isDemo', cl.is_demo,
               'role',   coalesce(club_role(cl.id),
                                  case when is_platform_admin() then 'admin' end),
               'viaPlatform', club_role(cl.id) is null,
               'leagues', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id',    l.id,
                            'slug',  l.slug,
                            'name',  l.name,
                            'plays', exists (
                              select 1 from league_members lm
                               where lm.league_id = l.id
                                 and lm.profile_id = auth.uid()
                                 and lm.status = 'active'))
                          order by l.name)
                   from leagues l
                  where l.club_id = cl.id
                    and l.status = 'active'
                    and sees_league(l.id)
               ), '[]'::jsonb)
             ) as club
        from clubs cl
       where cl.status <> 'closed'
         and (club_role(cl.id) is not null or is_platform_admin())
    ) as x;
$fn$;

/*
  Whether the caller has asked to join a club and is waiting, for the join
  page to say so. Their own row only.
*/
create or replace function my_club_request(in_slug text)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select m.status
    from club_members m
    join clubs c on c.id = m.club_id
   where c.slug = lower(btrim(in_slug)) and m.profile_id = auth.uid();
$fn$;

/*
  The leagues of a club a member can ask to play in, with where they stand in
  each. A player only sees the leagues they are in (sees_league), so without
  this a new member would have no league to ask for. Names only: nothing of a
  league's weeks or players.
*/
create or replace function club_league_choices(in_club_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name,
           'status', (select lm.status from league_members lm
                       where lm.league_id = l.id and lm.profile_id = auth.uid()))
           order by l.name), '[]'::jsonb)
    from leagues l
   where l.club_id = in_club_id
     and l.status = 'active'
     and exists (select 1 from club_members m
                  where m.club_id = in_club_id and m.profile_id = auth.uid()
                    and m.status = 'active');
$fn$;

-- ------------------------------------------------------------ who may call them

do $grants$
declare
  fn text;
begin
  -- Internal pieces: no caller needs them directly.
  foreach fn in array array[
    'profile_for_phone(text)', 'assert_club_admin(uuid)',
    'sync_pukagolf_admin(uuid, uuid)', 'assert_keeps_an_admin(uuid, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
  end loop;

  foreach fn in array array[
    'club_request_join(text)', 'club_decide(uuid, uuid, boolean)',
    'club_add_member(uuid, text, text)', 'club_set_role(uuid, uuid, text)',
    'club_set_staff_scores(uuid, uuid, boolean)', 'club_remove_member(uuid, uuid)',
    'league_create(uuid, text)', 'league_request_join(uuid)',
    'league_set_member(uuid, uuid, boolean)', 'club_admin_overview(uuid)',
    'platform_clubs()', 'platform_create_club(text, text, boolean, text)',
    'platform_set_club_status(uuid, text)', 'platform_note_view(uuid)',
    'my_clubs()', 'my_club_request(text)', 'club_league_choices(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;
