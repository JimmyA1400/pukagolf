/*
  The wall between clubs, for everything read or written straight from a
  table.

  Until now almost every table said "anyone signed in may read all of it" and
  "any admin may change all of it". With more than one club that would show
  Moose Ridge's rounds to a PukaGolf player and let a PukaGolf admin rewrite
  Moose Ridge's scores. Every policy here is replaced with one that asks
  which club the row belongs to:

    a player    sees the leagues they play in, and their own scores anywhere
    staff       see every league in their club, and fix scores where the
                club admin has allowed it
    a club admin
                sees and runs everything in their club, and can read (never
                change) the scores of their members wherever they played
    the platform admin
                sees everything

  and a player's scores from another club are shown to the members of a club
  they share only if the player has turned that on (profiles.show_scores).

  Functions that read or write through security definer bypass all of this,
  so the next migration gives each of them the same checks. Together they are
  the wall; neither is enough alone.

  The app still knows only one league. is_admin() and is_owner() keep their
  names and now mean "admin of PukaGolf", so every admin screen behaves as it
  does today for PukaGolf and does nothing for anyone else. The club-scoped
  admin pages that replace them are later work.
*/

-- ------------------------------------------------------------ show my scores

/*
  The player's own switch. Off by default: other members see a handicap, not
  the rounds behind it, unless the player says otherwise. Players may update
  their own row (own_profile_update), and this is a column they are meant to
  change, so it needs no pin there.

  First, because sees_score_of() below reads it.
*/
alter table profiles add column show_scores boolean not null default false;

-- ------------------------------------------------------------ who is who

/*
  Small, stable lookups the policies below are written in. Security definer
  so a policy can read club_members without needing a policy on it of its
  own that calls back into these. Every one of them takes the caller from
  auth.uid(), never from an argument, so none can be asked about somebody
  else.
  Each answers yes or no, never "unknown". SQL's null would read as no in a
  policy but as yes in "if not is_club_admin(...) then refuse", so a missing
  role must come back as false, not null.
*/

create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(exists (select 1 from platform_admins where profile_id = auth.uid()), false);
$fn$;

-- The caller's role in a club, if they are an active member of it.
create or replace function club_role(in_club_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select role from club_members
   where club_id = in_club_id and profile_id = auth.uid() and status = 'active';
$fn$;

create or replace function is_club_member(in_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select is_platform_admin() or club_role(in_club_id) is not null;
$fn$;

create or replace function is_club_staff(in_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select is_platform_admin() or coalesce(club_role(in_club_id) in ('admin', 'staff'), false);
$fn$;

create or replace function is_club_admin(in_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select is_platform_admin() or coalesce(club_role(in_club_id) = 'admin', false);
$fn$;

/*
  May the caller correct a score in this club: an admin, or a staff member
  the admin has allowed to. Correcting is not the same as entering: entering
  is may_score(), the rotation, and is the same for everyone.
*/
create or replace function can_fix_scores(in_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select is_platform_admin()
      or exists (
           select 1 from club_members
            where club_id = in_club_id
              and profile_id = auth.uid()
              and status = 'active'
              and (role = 'admin' or (role = 'staff' and staff_can_edit_scores))
         );
$fn$;

-- ------------------------------------------------------------ where things are

create or replace function league_club(in_league_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select club_id from leagues where id = in_league_id;
$fn$;

create or replace function round_league(in_round_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select league_id from rounds where id = in_round_id;
$fn$;

create or replace function round_club(in_round_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select l.club_id from rounds r join leagues l on l.id = r.league_id
   where r.id = in_round_id;
$fn$;

create or replace function tee_time_round(in_tee_time_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select round_id from tee_times where id = in_tee_time_id;
$fn$;

create or replace function event_club(in_event_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select club_id from events where id = in_event_id;
$fn$;

create or replace function course_club(in_course_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select club_id from courses where id = in_course_id;
$fn$;

create or replace function tournament_club(in_tournament_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select club_id from tournaments where id = in_tournament_id;
$fn$;

-- ------------------------------------------------------------ what one may see

/*
  A league is visible to the people who play in it and to its club's staff
  and admins. A player in the Saturday league doesn't see the Wednesday one.
*/
create or replace function sees_league(in_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select is_club_staff(league_club(in_league_id))
      or exists (
           select 1 from league_members
            where league_id = in_league_id
              and profile_id = auth.uid()
              and status = 'active'
         );
$fn$;

/*
  Somebody the caller shares a club with. Staff and admins also see the
  people who have asked to join, so they can decide; players see only active
  members.
*/
create or replace function shares_club(in_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
      from club_members me
      join club_members them on them.club_id = me.club_id
     where me.profile_id = auth.uid()
       and me.status = 'active'
       and them.profile_id = in_profile_id
       and (them.status = 'active'
            or (me.role in ('admin', 'staff') and them.status = 'requested'))
  );
$fn$;

/*
  May the caller see this player's score from a round in this league?

  Their own, always. Anyone who can see the league, because that is the
  leaderboard. Staff and admins of any club the player belongs to, wherever
  the round was played: a pro shop pairing a match needs to know how the
  player scores elsewhere. And otherwise only if the player has chosen to
  show their scores to the clubs they belong to.
*/
create or replace function sees_score_of(in_player_id uuid, in_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(in_player_id = auth.uid(), false)
      or sees_league(in_league_id)
      or is_platform_admin()
      or exists (
           select 1
             from club_members me
             join club_members them on them.club_id = me.club_id
            where me.profile_id = auth.uid()
              and me.status = 'active'
              and me.role in ('admin', 'staff')
              and them.profile_id = in_player_id
              and them.status = 'active'
         )
      or (coalesce((select show_scores from profiles where id = in_player_id), false)
          and shares_club(in_player_id));
$fn$;

/*
  Helpers are for policies and functions, not for the API: a signed-out
  caller has no club, and nobody needs to call these directly. (Supabase
  grants every new function to anon and authenticated by default.)
*/
do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'is_platform_admin()', 'club_role(uuid)', 'is_club_member(uuid)',
    'is_club_staff(uuid)', 'is_club_admin(uuid)', 'can_fix_scores(uuid)',
    'league_club(uuid)', 'round_league(uuid)', 'round_club(uuid)',
    'tee_time_round(uuid)', 'event_club(uuid)', 'course_club(uuid)',
    'tournament_club(uuid)', 'sees_league(uuid)', 'shares_club(uuid)',
    'sees_score_of(uuid, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

-- ------------------------------------------------------------ is_admin, is_owner

/*
  Same names, narrower meaning: an admin of PukaGolf (or the platform admin).
  Everything that called them keeps working for PukaGolf exactly as before,
  and can't be used by another club's admin, who isn't one. The owner's
  powers go to every PukaGolf admin, as decided for club admins generally;
  the two that reach beyond one club, merging and deleting accounts, move to
  the platform admin in the next migration.
*/
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select is_club_admin('a0000000-0000-4000-8000-000000000001');
$fn$;

create or replace function is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select is_club_admin('a0000000-0000-4000-8000-000000000001');
$fn$;

-- ------------------------------------------------------------ policies

/*
  Every old policy goes, by name, and the new ones are created below. Done
  table by table rather than "drop everything" so a policy added later by
  someone else is not silently removed.
*/
drop policy if exists admin_reads_audit       on audit_log;
drop policy if exists admin_charities         on charities;
drop policy if exists read_charities          on charities;
drop policy if exists admin_course_holes      on course_holes;
drop policy if exists read_course_holes       on course_holes;
drop policy if exists admin_tees              on course_tees;
drop policy if exists read_tees               on course_tees;
drop policy if exists admin_courses           on courses;
drop policy if exists read_courses            on courses;
drop policy if exists admin_event_players     on event_players;
drop policy if exists admin_event_scores      on event_scores;
drop policy if exists admin_event_team_members on event_team_members;
drop policy if exists admin_event_teams       on event_teams;
drop policy if exists admin_event_tee_time_teams on event_tee_time_teams;
drop policy if exists admin_event_tee_times   on event_tee_times;
drop policy if exists admin_events            on events;
drop policy if exists admin_feed              on feed_posts;
drop policy if exists delete_feed             on feed_posts;
drop policy if exists read_feed               on feed_posts;
drop policy if exists write_feed              on feed_posts;
drop policy if exists read_league_settings    on league_settings;
drop policy if exists admin_profiles          on profiles;
drop policy if exists read_profiles           on profiles;
drop policy if exists admin_round_matches     on round_matches;
drop policy if exists read_round_matches      on round_matches;
drop policy if exists admin_rsvp              on round_rsvps;
drop policy if exists own_rsvp_insert         on round_rsvps;
drop policy if exists own_rsvp_update         on round_rsvps;
drop policy if exists read_rsvps              on round_rsvps;
drop policy if exists admin_settings          on round_settings;
drop policy if exists read_settings           on round_settings;
drop policy if exists admin_round_team_players on round_team_players;
drop policy if exists read_round_team_players on round_team_players;
drop policy if exists admin_round_teams       on round_teams;
drop policy if exists read_round_teams        on round_teams;
drop policy if exists admin_rounds            on rounds;
drop policy if exists read_rounds             on rounds;
drop policy if exists admin_assignments       on scorer_assignments;
drop policy if exists read_assignments        on scorer_assignments;
drop policy if exists admin_deletes_scores    on scores;
drop policy if exists read_scores             on scores;
drop policy if exists scorer_inserts          on scores;
drop policy if exists scorer_updates          on scores;
drop policy if exists read_seasons            on seasons;
drop policy if exists admin_pairings          on tee_time_players;
drop policy if exists read_pairings           on tee_time_players;
drop policy if exists admin_requests          on tee_time_requests;
drop policy if exists delete_own_request      on tee_time_requests;
drop policy if exists read_own_request        on tee_time_requests;
drop policy if exists update_own_request      on tee_time_requests;
drop policy if exists write_own_request       on tee_time_requests;
drop policy if exists admin_tee_times         on tee_times;
drop policy if exists read_tee_times          on tee_times;
drop policy if exists admin_results           on tournament_results;
drop policy if exists read_results            on tournament_results;
drop policy if exists admin_t_rsvps           on tournament_rsvps;
drop policy if exists read_t_rsvps            on tournament_rsvps;
drop policy if exists admin_tournaments       on tournaments;
drop policy if exists read_tournaments        on tournaments;
-- own_profile_update on profiles stays exactly as it is.

-- clubs and who is in them

create policy read_clubs on clubs for select to authenticated
  using (is_club_member(id)
         or exists (select 1 from club_members m
                     where m.club_id = clubs.id and m.profile_id = auth.uid()));
create policy platform_clubs on clubs for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

create policy read_leagues on leagues for select to authenticated
  using (sees_league(id));
create policy admin_leagues on leagues for all to authenticated
  using (is_club_admin(club_id)) with check (is_club_admin(club_id));

create policy read_club_members on club_members for select to authenticated
  using (profile_id = auth.uid()
         or is_club_staff(club_id)
         or (status = 'active' and is_club_member(club_id)));
create policy platform_club_members on club_members for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

create policy read_league_members on league_members for select to authenticated
  using (profile_id = auth.uid()
         or is_club_staff(league_club(league_id))
         or (status = 'active' and sees_league(league_id)));
create policy platform_league_members on league_members for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

create policy read_own_platform_admin on platform_admins for select to authenticated
  using (profile_id = auth.uid());

-- people

create policy read_profiles on profiles for select to authenticated
  using (id = auth.uid() or is_platform_admin() or shares_club(id));
/*
  A profile is the person, across every club, so only the platform admin may
  change one directly. A club admin edits their members through functions
  that check the member is theirs.
*/
create policy platform_profiles on profiles for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

-- a week and everything in it

create policy read_rounds on rounds for select to authenticated
  using (sees_league(league_id));
create policy admin_rounds on rounds for all to authenticated
  using (is_club_admin(league_club(league_id)))
  with check (is_club_admin(league_club(league_id)));

create policy read_tee_times on tee_times for select to authenticated
  using (sees_league(round_league(round_id)));
create policy admin_tee_times on tee_times for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

create policy read_pairings on tee_time_players for select to authenticated
  using (sees_league(round_league(round_id)));
create policy admin_pairings on tee_time_players for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

create policy read_assignments on scorer_assignments for select to authenticated
  using (sees_league(round_league(tee_time_round(tee_time_id))));
-- Reassigning scorers is an admin's job, not staff's.
create policy admin_assignments on scorer_assignments for all to authenticated
  using (is_club_admin(round_club(tee_time_round(tee_time_id))))
  with check (is_club_admin(round_club(tee_time_round(tee_time_id))));

create policy read_settings on round_settings for select to authenticated
  using (sees_league(round_league(round_id)));
create policy admin_settings on round_settings for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

create policy read_round_teams on round_teams for select to authenticated
  using (sees_league(round_league(round_id)));
create policy admin_round_teams on round_teams for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

create policy read_round_team_players on round_team_players for select to authenticated
  using (sees_league(round_league(round_id)));
create policy admin_round_team_players on round_team_players for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

create policy read_round_matches on round_matches for select to authenticated
  using (sees_league(round_league(round_id)));
create policy admin_round_matches on round_matches for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

create policy read_rsvps on round_rsvps for select to authenticated
  using (sees_league(round_league(round_id)));
create policy own_rsvp_insert on round_rsvps for insert to authenticated
  with check (player_id = auth.uid()
              and sees_league(round_league(round_id))
              and exists (select 1 from rounds r
                           where r.id = round_rsvps.round_id
                             and (r.rsvp_lock_at is null or r.rsvp_lock_at > now())));
create policy own_rsvp_update on round_rsvps for update to authenticated
  using (player_id = auth.uid())
  with check (player_id = auth.uid()
              and sees_league(round_league(round_id))
              and exists (select 1 from rounds r
                           where r.id = round_rsvps.round_id
                             and (r.rsvp_lock_at is null or r.rsvp_lock_at > now())));
create policy admin_rsvp on round_rsvps for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

create policy read_own_request on tee_time_requests for select to authenticated
  using (player_id = auth.uid() or is_club_admin(round_club(round_id)));
create policy write_own_request on tee_time_requests for insert to authenticated
  with check (player_id = auth.uid() and status = 'pending'
              and sees_league(round_league(round_id)));
create policy update_own_request on tee_time_requests for update to authenticated
  using (player_id = auth.uid())
  with check (player_id = auth.uid() and status = 'pending');
create policy delete_own_request on tee_time_requests for delete to authenticated
  using (player_id = auth.uid() or is_club_admin(round_club(round_id)));
create policy admin_requests on tee_time_requests for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

create policy read_feed on feed_posts for select to authenticated
  using (sees_league(round_league(round_id)));
create policy write_feed on feed_posts for insert to authenticated
  with check (author_id = auth.uid() and sees_league(round_league(round_id)));
create policy delete_feed on feed_posts for delete to authenticated
  using (author_id = auth.uid() or is_club_admin(round_club(round_id)));
create policy admin_feed on feed_posts for all to authenticated
  using (is_club_admin(round_club(round_id)))
  with check (is_club_admin(round_club(round_id)));

/*
  Scores. Entering is the rotation, unchanged: may_score() says who holds
  whose card, in every club alike. Correcting is an admin, or staff the admin
  has allowed, of the club the round is in. Deleting is an admin's.
*/
create policy read_scores on scores for select to authenticated
  using (sees_score_of(player_id, round_league(round_id)));
create policy scorer_inserts on scores for insert to authenticated
  with check (entered_by = auth.uid()
              and (can_fix_scores(round_club(round_id)) or may_score(round_id, player_id)));
create policy scorer_updates on scores for update to authenticated
  using (can_fix_scores(round_club(round_id)) or may_score(round_id, player_id))
  with check (entered_by = auth.uid()
              and (can_fix_scores(round_club(round_id)) or may_score(round_id, player_id)));
create policy admin_deletes_scores on scores for delete to authenticated
  using (is_club_admin(round_club(round_id)));

create policy read_seasons on seasons for select to authenticated
  using (sees_league(league_id));

-- courses

/*
  A club's layouts are its members' business. Anyone playing a round reads
  its par and tees through the functions that build their card, so a player
  from another club doesn't need these tables.
*/
create policy read_courses on courses for select to authenticated
  using (is_club_member(club_id));
create policy admin_courses on courses for all to authenticated
  using (is_club_admin(club_id)) with check (is_club_admin(club_id));

create policy read_course_holes on course_holes for select to authenticated
  using (is_club_member(course_club(course_id)));
create policy admin_course_holes on course_holes for all to authenticated
  using (is_club_admin(course_club(course_id)))
  with check (is_club_admin(course_club(course_id)));

create policy read_tees on course_tees for select to authenticated
  using (is_club_member(course_club(course_id)));
create policy admin_tees on course_tees for all to authenticated
  using (is_club_admin(course_club(course_id)))
  with check (is_club_admin(course_club(course_id)));

-- outings and league events (read through their functions, as before)

create policy admin_events on events for all to authenticated
  using (is_club_admin(club_id)) with check (is_club_admin(club_id));
create policy admin_event_players on event_players for all to authenticated
  using (is_club_admin(event_club(event_id)))
  with check (is_club_admin(event_club(event_id)));
create policy admin_event_teams on event_teams for all to authenticated
  using (is_club_admin(event_club(event_id)))
  with check (is_club_admin(event_club(event_id)));
create policy admin_event_team_members on event_team_members for all to authenticated
  using (is_club_admin(event_club((select t.event_id from event_teams t where t.id = team_id))))
  with check (is_club_admin(event_club((select t.event_id from event_teams t where t.id = team_id))));
create policy admin_event_scores on event_scores for all to authenticated
  using (is_club_admin(event_club(event_id)))
  with check (is_club_admin(event_club(event_id)));
create policy admin_event_tee_times on event_tee_times for all to authenticated
  using (is_club_admin(event_club(event_id)))
  with check (is_club_admin(event_club(event_id)));
create policy admin_event_tee_time_teams on event_tee_time_teams for all to authenticated
  using (is_club_admin(event_club((select tt.event_id from event_tee_times tt where tt.id = tee_time_id))))
  with check (is_club_admin(event_club((select tt.event_id from event_tee_times tt where tt.id = tee_time_id))));

-- tournaments and charities

create policy read_tournaments on tournaments for select to authenticated
  using (is_club_member(club_id));
create policy admin_tournaments on tournaments for all to authenticated
  using (is_club_admin(club_id)) with check (is_club_admin(club_id));

create policy read_t_rsvps on tournament_rsvps for select to authenticated
  using (is_club_member(tournament_club(tournament_id)));
create policy admin_t_rsvps on tournament_rsvps for all to authenticated
  using (is_club_admin(tournament_club(tournament_id)))
  with check (is_club_admin(tournament_club(tournament_id)));

create policy read_results on tournament_results for select to authenticated
  using (is_club_member(tournament_club(tournament_id)));
create policy admin_results on tournament_results for all to authenticated
  using (is_club_admin(tournament_club(tournament_id)))
  with check (is_club_admin(tournament_club(tournament_id)));

create policy read_charities on charities for select to authenticated
  using (is_club_member(club_id));
create policy admin_charities on charities for all to authenticated
  using (is_club_admin(club_id)) with check (is_club_admin(club_id));

-- the one league's settings, and the site's own records

/*
  Still one row, PukaGolf's, until rules move onto each league. Only
  PukaGolf's members read it, so another club's players never pick up
  PukaGolf's rules by accident.
*/
create policy read_league_settings on league_settings for select to authenticated
  using (is_club_member('a0000000-0000-4000-8000-000000000001'));

-- The audit log spans every club, so for now only the platform admin reads it.
create policy platform_reads_audit on audit_log for select to authenticated
  using (is_platform_admin());

-- ------------------------------------------------------------ nothing left open

/*
  Every table in public must have row level security on, and none may be
  readable by everyone signed in. A table added later without thinking about
  clubs fails here, in the migration that adds it, instead of leaking.
*/
do $check$
declare
  open_tables text;
  open_policies text;
begin
  select string_agg(c.relname, ', ')
    into open_tables
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
     and not c.relrowsecurity;

  if open_tables is not null then
    raise exception 'Tables without row level security: %', open_tables;
  end if;

  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into open_policies
    from pg_policies
   where schemaname = 'public'
     and (qual = 'true' or with_check = 'true');

  if open_policies is not null then
    raise exception 'Policies that let everyone in: %', open_policies;
  end if;
end;
$check$;
