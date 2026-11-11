/*
  Test Valley: a made-up second club, for proving one club can't see or
  change another's data.

  Never applied to live. club_isolation.sql loads it inside a transaction it
  rolls back, so running the tests leaves nothing behind; loaded on its own
  into the test project it stays there, to click around in as a second club.

  Everyone in it is fictional and has no login (profiles only), and every id
  is fixed, beginning c, so a stray row is easy to spot and remove:

    c1  the club            c5  its week          c8  its tournament
    c2  its league          c6  the week's group  c9  its charity
    c3  its course          c7  its league event
    c4  its people (and Nina, in no club yet)

  One of its people, "Sam Shared", is also a member of PukaGolf and plays in
  its Saturday League: the cross-club cases (a club admin reading a member's
  scores from elsewhere, a player choosing to show their scores) need
  somebody in both.

  Runs as the table owner, which row level security doesn't apply to; it is
  test data being put in place, not a user doing something.
*/

insert into clubs (id, slug, name)
values ('c1000000-0000-4000-8000-000000000001', 'test-valley', 'Test Valley (test club)');

/*
  Two leagues, so "a player sees only the leagues they play in" has a league
  in the same club for them not to see.
*/
insert into leagues (id, club_id, slug, name) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
   'thursday', 'Test Valley Thursday'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001',
   'sunday', 'Test Valley Sunday'),
  -- And one with no weeks yet, for starting a league's first week.
  ('c2000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001',
   'wednesday', 'Test Valley Wednesday');

insert into courses (id, club_id, name, hole_count)
values ('c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
        'Test Valley Course', 9);

insert into course_holes (course_id, hole, par)
select 'c3000000-0000-4000-8000-000000000001', h, 4 from generate_series(1, 9) h;

insert into course_tees (course_id, tee_key, tee_name, tee_color, course_rating, slope, par, yardage)
values ('c3000000-0000-4000-8000-000000000001', 'white', 'White', 'White', 35.0, 120, 36, 3000);

insert into profiles (id, full_name) values
  ('c4000000-0000-4000-8000-000000000001', 'Tess Admin'),
  ('c4000000-0000-4000-8000-000000000002', 'Fiona Fixer'),
  ('c4000000-0000-4000-8000-000000000003', 'Stan Staff'),
  ('c4000000-0000-4000-8000-000000000004', 'Val One'),
  ('c4000000-0000-4000-8000-000000000005', 'Val Two'),
  ('c4000000-0000-4000-8000-000000000006', 'Val Three'),
  ('c4000000-0000-4000-8000-000000000007', 'Sam Shared');

-- Somebody with an account and no club yet, who wants to join one.
insert into profiles (id, full_name, phone)
values ('c4000000-0000-4000-8000-000000000008', 'Nina Newcomer', '+12395550199');

/*
  Everyone above signs in, as real players do. Partner Scoring treats a name
  with no login behind it differently (its player keeps their own card), so
  the cast needs logins for the ordinary rules to be the ones tested.
*/
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated',
       lower(replace(full_name, ' ', '.')) || '@test-valley.test', now(), now()
  from profiles
 where id::text like 'c4000000-0000-4000-8000-00000000000%';

insert into club_members (club_id, profile_id, role, status, staff_can_edit_scores, decided_at) values
  ('c1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'admin',  'active', false, now()),
  ('c1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'staff',  'active', true,  now()),
  ('c1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000003', 'staff',  'active', false, now()),
  ('c1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000004', 'player', 'active', false, now()),
  ('c1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005', 'player', 'active', false, now()),
  ('c1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000006', 'player', 'active', false, now()),
  ('c1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000007', 'player', 'active', false, now()),
  ('a0000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000007', 'player', 'active', false, now());

insert into league_members (league_id, profile_id, status, decided_at) values
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000004', 'active', now()),
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005', 'active', now()),
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000006', 'active', now()),
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000007', 'active', now()),
  ('b0000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000007', 'active', now());

insert into rounds (id, league_id, name, played_on, hole_count, status, course_id)
values ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
        'Test Valley Week 1', current_date, 9, 'live', 'c3000000-0000-4000-8000-000000000001');

-- The Sunday league's week. Nobody above plays in it.
insert into rounds (id, league_id, name, played_on, hole_count, status, course_id)
values ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002',
        'Test Valley Sunday Week 1', current_date, 9, 'setup', 'c3000000-0000-4000-8000-000000000001');

insert into tee_times (id, round_id, tee_at, starting_hole)
values ('c6000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001',
        now(), 1);

-- Val One, Two, Three and Sam, scoring in a ring: each keeps the next one's card.
insert into tee_time_players (tee_time_id, round_id, player_id, position) values
  ('c6000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000004', 0),
  ('c6000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005', 1),
  ('c6000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000006', 2),
  ('c6000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000007', 3);

insert into scorer_assignments (tee_time_id, scorer_player_id, scored_player_id) values
  ('c6000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-000000000005'),
  ('c6000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005', 'c4000000-0000-4000-8000-000000000006'),
  ('c6000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000006', 'c4000000-0000-4000-8000-000000000007'),
  ('c6000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000007', 'c4000000-0000-4000-8000-000000000004');

-- Hole 1 for everyone, entered by whoever keeps their card.
insert into scores (round_id, player_id, hole, strokes, entered_by) values
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000004', 1, 4, 'c4000000-0000-4000-8000-000000000007'),
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005', 1, 5, 'c4000000-0000-4000-8000-000000000004'),
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000006', 1, 3, 'c4000000-0000-4000-8000-000000000005'),
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000007', 1, 6, 'c4000000-0000-4000-8000-000000000006');

insert into feed_posts (round_id, author_id, body)
values ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000004',
        'Test Valley only: nobody at PukaGolf should ever read this.');

insert into events (id, club_id, league_id, scope, name, played_on, format, format_id,
                    team_size, hole_count, course_id, course_name, created_by)
values ('c7000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
        'c2000000-0000-4000-8000-000000000001', 'league', 'Test Valley Cup',
        current_date + 7, 'solo', 'stroke', 1, 9,
        'c3000000-0000-4000-8000-000000000001', 'Test Valley Course',
        'c4000000-0000-4000-8000-000000000001');

insert into event_players (event_id, name, profile_id, status) values
  ('c7000000-0000-4000-8000-000000000001', 'Val One', 'c4000000-0000-4000-8000-000000000004', 'in');

insert into charities (id, club_id, name)
values ('c9000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
        'Test Valley Junior Golf');

insert into tournaments (id, club_id, name, played_on, charity_id, raised, created_by)
values ('c8000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
        'Test Valley Open', current_date + 14, 'c9000000-0000-4000-8000-000000000001', 500,
        'c4000000-0000-4000-8000-000000000001');

insert into seasons (year, league_id, champion_name)
values (2001, 'c2000000-0000-4000-8000-000000000001', 'Val One');
