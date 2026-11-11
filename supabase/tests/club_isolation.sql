/*
  Proof that one club can't see or change another club's data.

      psql ... -f supabase/tests/test_valley.sql is loaded by this file; run
      this one: psql --no-psqlrc -v ON_ERROR_STOP=1 -f club_isolation.sql

  Everything happens inside one transaction that is rolled back at the end,
  so it can run against the test project, or a local copy, as often as
  wanted and leaves nothing behind. It is never run against live.

  Each check signs in as one person (by setting the same request settings
  Supabase sets from a login), runs one statement as them, and records what
  the database did:

    none / some       a read returned no rows, or some
    works             a change went through
    blocked           a change was refused outright or quietly matched no
                      rows, which is how row level security answers an
                      UPDATE or DELETE on rows you can't see
    refused           a function said no

  Whatever a check changes is undone straight after, so no check depends on
  another having run. The cast is Test Valley's people (test_valley.sql) and
  PukaGolf's real ones, looked up rather than named, so the same file works
  on any copy of live.

  Every check that should fail has a twin that should succeed, done by the
  person who is allowed: a wall that refuses everybody would pass the first
  half on its own.
*/

\set ON_ERROR_STOP on
begin;

\ir test_valley.sql

-- ------------------------------------------------------------ the cast

create temp table cast_ids (who text primary key, id uuid);

insert into cast_ids values
  ('tv_club',       'c1000000-0000-4000-8000-000000000001'),
  ('tv_league',     'c2000000-0000-4000-8000-000000000001'),
  ('tv_league2',    'c2000000-0000-4000-8000-000000000002'),
  ('tv_league3',    'c2000000-0000-4000-8000-000000000003'),
  ('tv_course',     'c3000000-0000-4000-8000-000000000001'),
  ('tv_admin',      'c4000000-0000-4000-8000-000000000001'),
  ('tv_fixer',      'c4000000-0000-4000-8000-000000000002'),
  ('tv_staff',      'c4000000-0000-4000-8000-000000000003'),
  ('tv_p1',         'c4000000-0000-4000-8000-000000000004'),
  ('tv_p2',         'c4000000-0000-4000-8000-000000000005'),
  ('tv_p3',         'c4000000-0000-4000-8000-000000000006'),
  ('sam',           'c4000000-0000-4000-8000-000000000007'),
  ('nina',          'c4000000-0000-4000-8000-000000000008'),
  ('tv_round',      'c5000000-0000-4000-8000-000000000001'),
  ('tv_round2',     'c5000000-0000-4000-8000-000000000002'),
  ('tv_tee',        'c6000000-0000-4000-8000-000000000001'),
  ('tv_event',      'c7000000-0000-4000-8000-000000000001'),
  ('tv_tournament', 'c8000000-0000-4000-8000-000000000001'),
  ('tv_charity',    'c9000000-0000-4000-8000-000000000001'),
  ('puka_club',     'a0000000-0000-4000-8000-000000000001'),
  ('saturday',      'b0000000-0000-4000-8000-000000000001');

-- PukaGolf's own: the platform admin, an admin who isn't, a player in a group.
insert into cast_ids
select 'p_owner', profile_id from platform_admins limit 1;

insert into cast_ids
select 'p_admin', m.profile_id
  from club_members m
 where m.club_id = 'a0000000-0000-4000-8000-000000000001' and m.role = 'admin'
   and m.profile_id not in (select profile_id from platform_admins)
 limit 1;

insert into cast_ids
select 'p_round', id from rounds
 where league_id = 'b0000000-0000-4000-8000-000000000001'
 order by played_on desc, created_at desc limit 1;

insert into cast_ids
select 'p_player', sa.scorer_player_id
  from scorer_assignments sa
  join tee_times t on t.id = sa.tee_time_id
  join club_members m on m.profile_id = sa.scorer_player_id
 where t.round_id = (select id from cast_ids where who = 'p_round')
   and m.club_id = 'a0000000-0000-4000-8000-000000000001' and m.role = 'player'
 limit 1;

insert into cast_ids
select 'p_scored', scored_player_id from scorer_assignments
 where scorer_player_id = (select id from cast_ids where who = 'p_player')
 limit 1;

insert into cast_ids
select 'p_tee', tee_time_id from tee_time_players
 where player_id = (select id from cast_ids where who = 'p_player')
   and round_id = (select id from cast_ids where who = 'p_round');

insert into cast_ids
select 'p_event', id from events
 where league_id = 'b0000000-0000-4000-8000-000000000001' limit 1;

do $cast$
declare
  missing text;
begin
  select string_agg(w, ', ') into missing
    from unnest(array['p_owner', 'p_admin', 'p_round', 'p_player', 'p_scored',
                      'p_tee', 'p_event']) w
   where not exists (select 1 from cast_ids c where c.who = w and c.id is not null);
  if missing is not null then
    raise exception 'This copy of the data has no %, so the tests can''t be cast.', missing;
  end if;
end;
$cast$;

-- PukaGolf's latest week may be marked final, which locks its cards; the
-- checks below are about who may score, so it is played as a live week.
update rounds set status = 'live' where id = (select id from cast_ids where who = 'p_round');

-- Sam plays at both clubs: a PukaGolf score of theirs, to be read from Test Valley.
insert into scores (round_id, player_id, hole, strokes, entered_by)
select (select id from cast_ids where who = 'p_round'),
       (select id from cast_ids where who = 'sam'),
       1, 5,
       (select id from cast_ids where who = 'p_admin');

-- ------------------------------------------------------------ the harness

create temp table results (
  n        serial primary key,
  actor    text,
  label    text,
  expected text,
  got      text,
  detail   text
);

create function pg_temp.check(in_actor text, in_label text, in_expected text, in_sql text)
returns void
language plpgsql
as $fn$
declare
  uid     uuid;
  stmt    text := in_sql;
  c       record;
  n       bigint;
  outcome text;
  why     text;
begin
  for c in select who, id from cast_ids loop
    stmt := replace(stmt, '{' || c.who || '}', quote_literal(c.id) || '::uuid');
  end loop;

  if in_actor <> 'anon' then
    select id into uid from cast_ids where who = in_actor;
    if uid is null then
      raise exception 'No one in the cast is called %.', in_actor;
    end if;
  end if;

  begin
    perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
    perform set_config('request.jwt.claims',
                       json_build_object('sub', uid,
                                         'role', case when uid is null then 'anon'
                                                      else 'authenticated' end)::text,
                       true);
    perform set_config('role', case when uid is null then 'anon' else 'authenticated' end, true);

    if in_expected in ('none', 'some') then
      execute format('select count(*) from (%s) as q', stmt) into n;
      outcome := case when n = 0 then 'none' else 'some' end;
    else
      execute stmt;
      get diagnostics n = row_count;
      outcome := case when n = 0 then 'blocked' else 'works' end;
    end if;

    -- Undo whatever it did, keeping what we learned.
    raise exception using message = '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then
      outcome := case when in_expected = 'refused' then 'refused' else 'blocked' end;
      why := sqlerrm;
    end if;
  end;

  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  insert into results (actor, label, expected, got, detail)
  values (in_actor, in_label, in_expected,
          -- A refusal answers "blocked" too: both mean it didn't happen.
          case when in_expected = 'blocked' and outcome = 'refused' then 'blocked'
               else outcome end,
          why);
end;
$fn$;

-- What a call said when it refused, or null when it went through.
create function pg_temp.message_of(in_sql text)
returns text
language plpgsql
as $fn$
begin
  execute in_sql;
  return null;
exception when others then
  return sqlerrm;
end;
$fn$;

-- Change a signed-off card with a reason, then read the card's history.
create function pg_temp.fix_and_read(in_round uuid, in_player uuid, in_reason text)
returns setof jsonb
language plpgsql
as $fn$
begin
  perform admin_fix_signed_score(in_round, in_player, 1, 3, in_reason);
  return query select e from jsonb_array_elements(card_history(in_round, in_player)) e;
end;
$fn$;

-- Sign a group's cards, then read how each card is now locked and by whom.
create function pg_temp.sign_and_read(in_tee uuid)
returns table (how text, locked_by uuid)
language plpgsql
as $fn$
begin
  perform sign_off_group(in_tee);
  return query select cl.how, cl.locked_by from card_locks cl
                join tee_time_players ttp on ttp.round_id = cl.round_id and ttp.player_id = cl.player_id
               where ttp.tee_time_id = in_tee;
end;
$fn$;

-- Take back a group's sign-off, then say what is left locked in the week,
-- as 'signed:n admin:n' (0057).
create function pg_temp.take_back_and_read(in_round uuid, in_player uuid)
returns text
language plpgsql
as $fn$
begin
  perform admin_take_back_sign_off(in_round, in_player);
  return (select format('signed:%s admin:%s',
                        count(*) filter (where how = 'signed'),
                        count(*) filter (where how = 'admin'))
            from card_locks where round_id = in_round);
end;
$fn$;

-- Clear a week's scores, then count the locks left in it (0057).
create function pg_temp.clear_and_count(in_round uuid)
returns bigint
language plpgsql
as $fn$
begin
  perform owner_clear_round_scores(in_round);
  return (select count(*) from card_locks where round_id = in_round);
end;
$fn$;

-- Mark a week final as the admin page does, then read its club's log for
-- the line that wrote, through the log the club's admins read (0057).
create function pg_temp.final_and_read(in_round uuid, in_club uuid)
returns setof jsonb
language plpgsql
as $fn$
begin
  perform owner_update_round(in_round, r.name, r.played_on, 'final')
     from rounds r where r.id = in_round;
  return query select e from jsonb_array_elements(club_audit_log(in_club, 200, null)) e
                where e->>'action' = 'final' and e->>'entityId' = in_round::text;
end;
$fn$;

-- Mark a week final, then take back a group's sign-off in it, with or
-- without a reason; how many cards it freed (0058).
create function pg_temp.final_take_back(in_round uuid, in_player uuid, in_reason text)
returns integer
language plpgsql
as $fn$
begin
  perform owner_update_round(in_round, r.name, r.played_on, 'final')
     from rounds r where r.id = in_round;
  return admin_take_back_sign_off(in_round, in_player, in_reason);
end;
$fn$;

-- As final_take_back, then the reason the club's own log kept for it.
create function pg_temp.final_take_back_reason(in_round uuid, in_player uuid, in_club uuid, in_reason text)
returns text
language plpgsql
as $fn$
begin
  perform pg_temp.final_take_back(in_round, in_player, in_reason);
  return (select e->'detail'->>'reason' from jsonb_array_elements(club_audit_log(in_club, 200, null)) e
           where e->>'action' = 'take_back' limit 1);
end;
$fn$;

-- Set a league's rules twice, the same both times; how many lines that
-- wrote in the club's own log (0058).
create function pg_temp.rules_lines(in_league uuid, in_club uuid, in_mode text)
returns bigint
language plpgsql
as $fn$
begin
  perform league_set_scoring_mode(in_league, in_mode);
  perform league_set_scoring_mode(in_league, in_mode);
  perform league_set_double_par_cap(in_league, false);
  perform league_set_double_par_cap(in_league, false);
  -- Each check is undone after, so this transaction's lines are these.
  return (select count(*) from jsonb_array_elements(club_audit_log(in_club, 200, null)) e
           where e->>'entity' = 'league_rules' and e->>'entityId' = in_league::text
             and (e->>'at')::timestamptz = now());
end;
$fn$;

-- Enter hole 9 as the admin page does, with or without the phone's time,
-- and read the phone time the club's log kept for that write (0059).
create function pg_temp.phone_at_of(in_round uuid, in_player uuid, in_club uuid, in_phone timestamptz)
returns text
language plpgsql
as $fn$
begin
  insert into scores (round_id, player_id, hole, strokes, entered_by, entered_on_phone_at)
  values (in_round, in_player, 9, 4, auth.uid(), in_phone)
  on conflict (round_id, player_id, hole) do update
    set strokes = scores.strokes % 9 + 1,
        entered_by = excluded.entered_by,
        entered_on_phone_at = excluded.entered_on_phone_at;
  return (select e->'detail'->>'phoneAt'
            from jsonb_array_elements(club_audit_log(in_club, 50, null)) e
           where e->>'entity' = 'score'
           limit 1);
end;
$fn$;

-- Clear a week's scores, then read the week's status (0059).
create function pg_temp.clear_status(in_round uuid)
returns text
language plpgsql
as $fn$
begin
  perform owner_clear_round_scores(in_round);
  return (select status from rounds where id = in_round);
end;
$fn$;

-- Clear a week, optionally score one hole again, then put the cleared
-- scores back (0060). Says "put back/kept/new hole 1/still listed".
create function pg_temp.put_back(in_round uuid, in_player uuid, in_rescore boolean)
returns text
language plpgsql
as $fn$
declare
  back   integer;
  listed jsonb;
begin
  perform owner_clear_round_scores(in_round);
  if in_rescore then
    insert into scores (round_id, player_id, hole, strokes, entered_by)
    values (in_round, in_player, 1, 9, auth.uid());
  end if;
  select e into listed from jsonb_array_elements(owner_restorable_scores()) e
   where e->>'roundId' = in_round::text;
  back := owner_restore_scores(in_round);
  return format('%s/%s/%s/%s', back, listed->>'kept',
                (select strokes from scores where round_id = in_round and player_id = in_player and hole = 1),
                exists (select 1 from jsonb_array_elements(owner_restorable_scores()) e
                         where e->>'roundId' = in_round::text));
end;
$fn$;

-- Set one rule and set it back, as the rules page does; what each of the
-- lines it wrote says the rule went from and to (0060).
create function pg_temp.drop_worst_lines(in_league uuid, in_club uuid)
returns text
language plpgsql
as $fn$
declare
  r league_rules%rowtype;
  n integer;
begin
  select * into r from league_rules where league_id = in_league;
  foreach n in array array[r.drop_worst + 1, r.drop_worst, r.drop_worst] loop
    perform owner_set_league_rules(in_league, r.points_table::integer[], r.completion_point, n,
                                   r.min_weeks, r.ranking, r.guests_score, r.default_skins_stake,
                                   r.default_game, r.stableford_points::integer[]);
  end loop;
  return (select string_agg(format('%s>%s', e->'detail'->'was'->>'drop_worst', e->'detail'->>'drop_worst'),
                            ',' order by (e->>'id')::bigint)
            from jsonb_array_elements(club_audit_log(in_club, 50, null)) e
           where e->>'entity' = 'league_rules' and e->>'entityId' = in_league::text
             and (e->>'at')::timestamptz = now());
end;
$fn$;

-- Save hole 1 again with the number it has, then change it: how many
-- score lines that wrote in the club's log (0061).
create function pg_temp.same_then_new(in_round uuid, in_player uuid, in_club uuid)
returns bigint
language plpgsql
as $fn$
begin
  update scores set strokes = strokes, updated_at = now()
   where round_id = in_round and player_id = in_player and hole = 1;
  update scores set strokes = strokes % 9 + 1
   where round_id = in_round and player_id = in_player and hole = 1;
  return (select count(*) from jsonb_array_elements(club_audit_log(in_club, 50, null)) e
           where e->>'entity' = 'score' and (e->>'at')::timestamptz = now());
end;
$fn$;

-- Clear a week; "reason, in order" when every "removed" line it wrote says
-- why and they go player by player, hole by hole (0061).
create function pg_temp.clear_lines(in_round uuid, in_club uuid)
returns text
language plpgsql
as $fn$
declare
  lines jsonb;
begin
  perform owner_clear_round_scores(in_round);
  select jsonb_agg(e order by (e->>'id')::bigint) into lines
    from jsonb_array_elements(club_audit_log(in_club, 200, null)) e
   where e->>'entity' = 'score' and e->>'action' = 'delete' and (e->>'at')::timestamptz = now();
  return case
    when lines is null then 'no lines'
    when exists (select 1 from jsonb_array_elements(lines) l
                  where l->'detail'->>'reason' is distinct from 'Cleared with “Clear all”') then 'no reason'
    when (select array_agg((l->'detail'->>'player_id') || ':' || lpad(l->'detail'->>'hole', 2, '0') order by o)
            from jsonb_array_elements(lines) with ordinality as x(l, o))
         = (select array_agg(k order by k)
              from (select (l->'detail'->>'player_id') || ':' || lpad(l->'detail'->>'hole', 2, '0') as k
                      from jsonb_array_elements(lines) l) as y) then 'reason, in order'
    else 'out of order'
  end;
end;
$fn$;

-- Ask for n lookups in a row; true if the last one was still allowed.
create function pg_temp.lookups(in_n integer, in_ip text default null)
returns boolean
language plpgsql
as $fn$
declare
  ok boolean;
begin
  for i in 1 .. in_n loop
    ok := api_lookup_allowed(in_ip);
  end loop;
  return ok;
end;
$fn$;

-- The same, as several players in turn from one network. Switching who is
-- signed in mid-call is the harness's doing; a real caller can't.
create function pg_temp.lookups_as(in_who uuid[], in_n integer, in_ip text)
returns boolean
language plpgsql
as $fn$
declare
  ok boolean;
  w uuid;
begin
  foreach w in array in_who loop
    perform set_config('request.jwt.claim.sub', w::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', w, 'role', 'authenticated')::text, true);
    ok := pg_temp.lookups(in_n, in_ip);
  end loop;
  return ok;
end;
$fn$;

-- Try n numbers nobody has signed up with, as an admin adding members.
create function pg_temp.add_numbers(in_club uuid, in_n integer)
returns void
language plpgsql
as $fn$
begin
  for i in 1 .. in_n loop
    perform club_add_member(in_club, '(239) 555-' || lpad((1000 + i)::text, 4, '0'), 'player');
  end loop;
end;
$fn$;

-- Each check prints an empty row; only the verdict below is worth reading.
\o /dev/null

-- ------------------------------------------------------------ PukaGolf can't see Test Valley

select pg_temp.check('p_player', 'their week',               'none', 'select 1 from rounds where id = {tv_round}');
select pg_temp.check('p_player', 'their groups',             'none', 'select 1 from tee_times where round_id = {tv_round}');
select pg_temp.check('p_player', 'their pairings',           'none', 'select 1 from tee_time_players where round_id = {tv_round}');
select pg_temp.check('p_player', 'their scorer ring',        'none', 'select 1 from scorer_assignments where tee_time_id = {tv_tee}');
select pg_temp.check('p_player', 'their week settings',      'none', 'select 1 from round_settings where round_id = {tv_round}');
select pg_temp.check('p_player', 'their scores',             'none', 'select 1 from scores where round_id = {tv_round}');
select pg_temp.check('p_player', 'their clubhouse feed',     'none', 'select 1 from feed_posts where round_id = {tv_round}');
select pg_temp.check('p_player', 'their seasons',            'none', 'select 1 from seasons where league_id = {tv_league}');
select pg_temp.check('p_player', 'their club',               'none', 'select 1 from clubs where id = {tv_club}');
select pg_temp.check('p_player', 'their leagues',            'none', 'select 1 from leagues where club_id = {tv_club}');
select pg_temp.check('p_player', 'their members',            'none', 'select 1 from club_members where club_id = {tv_club}');
select pg_temp.check('p_player', 'their league rosters',     'none', 'select 1 from league_members where league_id = {tv_league}');
select pg_temp.check('p_player', 'their course',             'none', 'select 1 from courses where id = {tv_course}');
select pg_temp.check('p_player', 'their pars',               'none', 'select 1 from course_holes where course_id = {tv_course}');
select pg_temp.check('p_player', 'their tees',               'none', 'select 1 from course_tees where course_id = {tv_course}');
select pg_temp.check('p_player', 'their tournament',         'none', 'select 1 from tournaments where id = {tv_tournament}');
select pg_temp.check('p_player', 'their charity',            'none', 'select 1 from charities where id = {tv_charity}');
select pg_temp.check('p_player', 'a Test Valley-only player','none', 'select 1 from profiles where id = {tv_p1}');
select pg_temp.check('p_player', 'their events in the list', 'none', $$select 1 from jsonb_array_elements(league_events({tv_league})) e where e->>'id' = {tv_event}::text$$);
select pg_temp.check('p_player', 'their event, opened by id','refused','select league_event({tv_event})');
select pg_temp.check('p_player', 'their weeks in the season','none', $$select 1 where league_season({saturday})::text like '%Test Valley%'$$);
select pg_temp.check('p_player', 'a TV player''s history',   'none', $$select 1 where player_rounds({tv_p1}) <> '[]'::jsonb$$);
select pg_temp.check('p_player', 'their week''s progress',   'none', 'select 1 where round_completion({tv_round}) is not null');
select pg_temp.check('p_player', 'their charity''s totals',  'none', $$select 1 where charity_totals({tv_club})::text like '%Test Valley%'$$);

-- PukaGolf still works for PukaGolf: the same reads, of their own.
select pg_temp.check('p_player', 'own week',                 'some', 'select 1 from rounds where id = {p_round}');
select pg_temp.check('p_player', 'own week''s scores',       'some', 'select 1 from scores where round_id = {p_round}');
select pg_temp.check('p_player', 'own groups',               'some', 'select 1 from tee_times where round_id = {p_round}');
select pg_temp.check('p_player', 'own scorer ring',          'some', 'select 1 from scorer_assignments where tee_time_id = {p_tee}');
select pg_temp.check('p_player', 'a league-mate',            'some', 'select 1 from profiles where id = {p_admin}');
select pg_temp.check('p_player', 'own league''s season',     'some', $$select 1 where jsonb_array_length(league_season({saturday})->'rounds') > 0$$);
select pg_temp.check('p_player', 'own league''s events',     'some', 'select 1 from jsonb_array_elements(league_events({saturday}))');
select pg_temp.check('p_player', 'own league''s rules',      'some', 'select 1 from league_settings');
select pg_temp.check('p_player', 'own club''s courses',      'some', 'select 1 from courses where club_id = {puka_club}');
select pg_temp.check('p_player', 'own club',                 'some', 'select 1 from clubs where id = {puka_club}');

-- ------------------------------------------------------------ Test Valley can't see PukaGolf

select pg_temp.check('tv_p1', 'PukaGolf''s week',            'none', 'select 1 from rounds where id = {p_round}');
select pg_temp.check('tv_p1', 'PukaGolf''s scores',          'none', 'select 1 from scores where round_id = {p_round}');
select pg_temp.check('tv_p1', 'PukaGolf''s groups',          'none', 'select 1 from tee_times where round_id = {p_round}');
select pg_temp.check('tv_p1', 'a PukaGolf-only player',      'none', 'select 1 from profiles where id = {p_player}');
select pg_temp.check('tv_p1', 'PukaGolf''s rules',           'none', 'select 1 from league_settings');
select pg_temp.check('tv_p1', 'PukaGolf''s courses',         'none', 'select 1 from courses where club_id = {puka_club}');
select pg_temp.check('tv_p1', 'PukaGolf''s club',            'none', 'select 1 from clubs where id = {puka_club}');
select pg_temp.check('tv_p1', 'PukaGolf''s members',         'none', 'select 1 from club_members where club_id = {puka_club} and profile_id <> {sam}');
select pg_temp.check('tv_p1', 'PukaGolf''s season',          'refused','select league_season({saturday})');
select pg_temp.check('tv_p1', 'PukaGolf''s event',           'refused','select league_event({p_event})');
select pg_temp.check('tv_p1', 'PukaGolf''s events in the list','none', $$select 1 from jsonb_array_elements(league_events({saturday})) e where e->>'id' = {p_event}::text$$);
select pg_temp.check('tv_p1', 'a PukaGolf player''s history','none', $$select 1 where player_rounds({p_player}) <> '[]'::jsonb$$);

-- ... and sees its own.
select pg_temp.check('tv_p1', 'own week',                    'some', 'select 1 from rounds where id = {tv_round}');
select pg_temp.check('tv_p1', 'own week''s scores',          'some', 'select 1 from scores where round_id = {tv_round}');
select pg_temp.check('tv_p1', 'a league-mate',               'some', 'select 1 from profiles where id = {tv_p2}');
select pg_temp.check('tv_p1', 'own event',                   'some', 'select league_event({tv_event})');

-- ------------------------------------------------------------ the club switcher

select pg_temp.check('p_player', 'Test Valley in their club list',  'none', $$select 1 from jsonb_array_elements(my_clubs()) c where c->>'slug' = 'test-valley'$$);
select pg_temp.check('p_player', 'PukaGolf in their club list',     'some', $$select 1 from jsonb_array_elements(my_clubs()) c where c->>'slug' = 'pukagolf'$$);
select pg_temp.check('tv_p1',    'PukaGolf in their club list',     'none', $$select 1 from jsonb_array_elements(my_clubs()) c where c->>'slug' = 'pukagolf'$$);
select pg_temp.check('tv_p1',    'the Sunday league in their list', 'none', $$select 1 from jsonb_array_elements(my_clubs()) c, jsonb_array_elements(c->'leagues') l where l->>'slug' = 'sunday'$$);
select pg_temp.check('tv_staff', 'the Sunday league in their list', 'some', $$select 1 from jsonb_array_elements(my_clubs()) c, jsonb_array_elements(c->'leagues') l where l->>'slug' = 'sunday'$$);
select pg_temp.check('sam',      'both clubs in their list',        'some', $$select 1 where jsonb_array_length(my_clubs()) = 2$$);
select pg_temp.check('tv_p1',    'own league''s season',            'some', $$select 1 where jsonb_array_length(league_season({tv_league})->'rounds') > 0$$);
select pg_temp.check('tv_p1',    'the Sunday league''s season',     'refused', 'select league_season({tv_league2})');
select pg_temp.check('p_player', 'Test Valley''s charities, asked by club', 'none', $$select 1 where charity_totals({tv_club}) <> '[]'::jsonb$$);
select pg_temp.check('anon',     'a club''s public name',           'some', $$select 1 where club_public('test-valley') is not null$$);
select pg_temp.check('anon',     'a club that doesn''t exist',      'none', $$select 1 where club_public('no-such-club') is not null$$);
select pg_temp.check('anon',     'anyone''s club list',             'refused', 'select my_clubs()');

-- ------------------------------------------------------------ leagues inside one club

select pg_temp.check('tv_p1',    'a league they don''t play in', 'none', 'select 1 from rounds where id = {tv_round2}');
select pg_temp.check('tv_staff', 'every league in their club',   'some', 'select 1 from rounds where id = {tv_round2}');
select pg_temp.check('tv_admin', 'every league in their club',   'some', 'select 1 from rounds where id = {tv_round2}');

-- ------------------------------------------------------------ a member's scores from elsewhere

-- Staff and admins read their members' scores wherever they were played ...
select pg_temp.check('tv_admin', 'Sam''s PukaGolf score',        'some', 'select 1 from scores where player_id = {sam} and round_id = {p_round}');
select pg_temp.check('tv_fixer', 'Sam''s PukaGolf score',        'some', 'select 1 from scores where player_id = {sam} and round_id = {p_round}');
select pg_temp.check('p_admin',  'Sam''s Test Valley score',     'some', 'select 1 from scores where player_id = {sam} and round_id = {tv_round}');
-- ... but not anyone else's there, and not the week itself.
select pg_temp.check('tv_admin', 'a PukaGolf-only player''s score','none','select 1 from scores where player_id = {p_player}');
select pg_temp.check('tv_admin', 'the PukaGolf week Sam played', 'none', 'select 1 from rounds where id = {p_round}');
select pg_temp.check('p_admin',  'a TV-only player''s score',    'none', 'select 1 from scores where player_id = {tv_p1}');

-- Players see another club's scores of a fellow member only if that member says so.
select pg_temp.check('p_player', 'Sam''s TV score, Sam''s switch off', 'none', 'select 1 from scores where player_id = {sam} and round_id = {tv_round}');
select pg_temp.check('sam',      'turns on "show my scores"',    'works', 'update profiles set show_scores = true where id = {sam}');

update profiles set show_scores = true where id = 'c4000000-0000-4000-8000-000000000007';

select pg_temp.check('p_player', 'Sam''s TV score, Sam''s switch on',  'some', 'select 1 from scores where player_id = {sam} and round_id = {tv_round}');
select pg_temp.check('p_player', 'still not the TV week itself', 'none', 'select 1 from rounds where id = {tv_round}');
select pg_temp.check('p_player', 'still not Val One''s score',   'none', 'select 1 from scores where player_id = {tv_p1}');
select pg_temp.check('tv_p1',    'Sam''s PukaGolf score, switch on',   'some', 'select 1 from scores where player_id = {sam} and round_id = {p_round}');

update profiles set show_scores = false where id = 'c4000000-0000-4000-8000-000000000007';

-- ------------------------------------------------------------ a PukaGolf admin can't change Test Valley

select pg_temp.check('p_admin', 'rename their week',          'blocked', $$update rounds set name = 'changed' where id = {tv_round}$$);
select pg_temp.check('p_admin', 'add a score to their week',  'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p1}, 2, 1, {p_admin})');
select pg_temp.check('p_admin', 'change their scores',        'blocked', 'update scores set strokes = 1, entered_by = {p_admin} where round_id = {tv_round}');
select pg_temp.check('p_admin', 'delete their scores',        'blocked', 'delete from scores where round_id = {tv_round}');
select pg_temp.check('p_admin', 'rewire their scorers',       'blocked', 'update scorer_assignments set scorer_player_id = {tv_p3} where tee_time_id = {tv_tee}');
select pg_temp.check('p_admin', 'post in their feed',         'blocked', $$insert into feed_posts (round_id, author_id, body) values ({tv_round}, {p_admin}, 'x')$$);
select pg_temp.check('p_admin', 'rename their course',        'blocked', $$update courses set name = 'x' where id = {tv_course}$$);
select pg_temp.check('p_admin', 'add a hole to their course', 'blocked', 'insert into course_holes (course_id, hole, par) values ({tv_course}, 10, 4)');
select pg_temp.check('p_admin', 'rename their tournament',    'blocked', $$update tournaments set name = 'x' where id = {tv_tournament}$$);
select pg_temp.check('p_admin', 'rename their charity',       'blocked', $$update charities set name = 'x' where id = {tv_charity}$$);
select pg_temp.check('p_admin', 'rename their event',         'blocked', $$update events set name = 'x' where id = {tv_event}$$);
select pg_temp.check('p_admin', 'rename one of their players','blocked', $$update profiles set full_name = 'x' where id = {tv_p1}$$);
select pg_temp.check('p_admin', 'make themself TV''s admin',  'blocked', $$insert into club_members (club_id, profile_id, role, status) values ({tv_club}, {p_admin}, 'admin', 'active')$$);
select pg_temp.check('p_admin', 'join TV''s league',          'blocked', $$insert into league_members (league_id, profile_id, status) values ({tv_league}, {p_admin}, 'active')$$);
select pg_temp.check('p_admin', 'make themself platform admin','blocked','insert into platform_admins (profile_id) values ({p_admin})');
select pg_temp.check('p_admin', 'move one of their groups',   'refused', 'select admin_set_group_time({tv_tee}, now())');
select pg_temp.check('p_admin', 'add a group to their week',  'refused', 'select admin_add_group({tv_round}, now(), 4)');
select pg_temp.check('p_admin', 'place a player in their week','refused','select admin_place_player({tv_round}, {tv_p1}, null)');
select pg_temp.check('p_admin', 'rename their week (function)','refused',$$select owner_update_round({tv_round}, 'x', current_date, 'live')$$);
select pg_temp.check('p_admin', 'clear their week''s scores', 'refused', 'select owner_clear_round_scores({tv_round})');
select pg_temp.check('p_admin', 'close their week',           'refused', 'select complete_round({tv_round}, true)');
select pg_temp.check('p_admin', 'change their week''s game',  'refused', $$select admin_set_week_game({tv_round}, 'stroke', null)$$);
select pg_temp.check('p_admin', 'take their week out of the standings','refused','select owner_set_round_counts({tv_round}, false)');
select pg_temp.check('p_admin', 'answer for their player',    'refused', $$select set_rsvp({tv_round}, 'in', {tv_p1})$$);
select pg_temp.check('p_admin', 'delete their event',         'refused', 'select admin_delete_event({tv_event})');
select pg_temp.check('p_admin', 'change their event',         'refused', 'select admin_event_set_flags({tv_event}, true, false)');
select pg_temp.check('p_admin', 'set their player''s handicap','refused','select owner_set_handicap({tv_p1}, 1)');
select pg_temp.check('p_admin', 'rename their player',        'refused', $$select owner_update_player({tv_p1}, 'Changed Name', null)$$);
select pg_temp.check('p_admin', 'rename a player both clubs share','refused',$$select owner_update_player({sam}, 'Changed Name', null)$$);
select pg_temp.check('p_admin', 'invite their player to a PukaGolf event','none',$$select 1 where admin_event_invite({p_event}, array[{tv_p1}]) > 0$$);
select pg_temp.check('p_admin', 'merge accounts',             'refused', 'select owner_merge_players({p_player}, {tv_p1})');
select pg_temp.check('p_admin', 'delete an account',          'refused', 'select owner_remove_player({tv_p1})');
select pg_temp.check('p_admin', 'read the whole audit log',   'refused', 'select owner_audit_log(50, null)');

-- ... and can still run PukaGolf.
select pg_temp.check('p_admin', 'rename own week',            'works', 'update rounds set name = name where id = {p_round}');
select pg_temp.check('p_admin', 'move own group',             'works', 'select admin_set_group_time({p_tee}, now())');
select pg_temp.check('p_admin', 'set own player''s handicap', 'works', 'select owner_set_handicap({p_player}, 10)');
select pg_temp.check('p_admin', 'correct an own score',       'works', 'update scores set strokes = strokes, entered_by = {p_admin} where round_id = {p_round}');
select pg_temp.check('p_admin', 'open the admin page',        'works', 'select owner_league_overview({saturday})');
select pg_temp.check('p_admin', 'set the announcement',       'works', $$select admin_set_announcement({saturday}, 'Rehearsal')$$);

-- ------------------------------------------------------------ a Test Valley admin can't change PukaGolf

select pg_temp.check('tv_admin', 'rename PukaGolf''s week',   'blocked', $$update rounds set name = 'changed' where id = {p_round}$$);
select pg_temp.check('tv_admin', 'change PukaGolf''s scores', 'blocked', 'update scores set strokes = 1, entered_by = {tv_admin} where round_id = {p_round}');
select pg_temp.check('tv_admin', 'change PukaGolf''s rules',  'blocked', $$update league_settings set announcement = 'x'$$);
select pg_temp.check('tv_admin', 'move PukaGolf''s group',    'refused', 'select admin_set_group_time({p_tee}, now())');
select pg_temp.check('tv_admin', 'set PukaGolf''s announcement','refused',$$select admin_set_announcement({saturday}, 'x')$$);
select pg_temp.check('tv_admin', 'start PukaGolf''s next week','refused', $$select owner_start_new_week({saturday}, 'x', current_date + 30)$$);
select pg_temp.check('tv_admin', 'open PukaGolf''s admin page','refused', 'select owner_league_overview({saturday})');
select pg_temp.check('tv_admin', 'set a PukaGolf handicap',   'refused', 'select owner_set_handicap({p_player}, 1)');
select pg_temp.check('tv_admin', 'rename a PukaGolf player',  'refused', $$select owner_update_player({p_player}, 'Changed Name', null)$$);
select pg_temp.check('tv_admin', 'rename a player both clubs share','refused',$$select owner_update_player({sam}, 'Changed Name', null)$$);

-- ... and can run Test Valley.
select pg_temp.check('tv_admin', 'rename own week',           'works', 'update rounds set name = name where id = {tv_round}');
select pg_temp.check('tv_admin', 'move own group',            'works', 'select admin_set_group_time({tv_tee}, now())');
select pg_temp.check('tv_admin', 'correct an own score',      'works', 'update scores set strokes = 4, entered_by = {tv_admin} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_admin', 'rewire own scorers',        'works', 'update scorer_assignments set updated_at = now() where tee_time_id = {tv_tee}');
select pg_temp.check('tv_admin', 'set own player''s handicap','works', 'select owner_set_handicap({tv_p1}, 12)');
select pg_temp.check('tv_admin', 'rename own player',         'works', $$select owner_update_player({tv_p1}, 'Val Uno', null)$$);

-- ------------------------------------------------------------ staff

select pg_temp.check('tv_fixer', 'correct a score (allowed to)','works', 'update scores set strokes = 4, entered_by = {tv_fixer} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_fixer', 'rewire scorers (admins only)','blocked','update scorer_assignments set updated_at = now() where tee_time_id = {tv_tee}');
select pg_temp.check('tv_fixer', 'rename the week (admins only)','blocked',$$update rounds set name = 'x' where id = {tv_round}$$);
select pg_temp.check('tv_fixer', 'correct a PukaGolf score',  'blocked', 'update scores set strokes = 1, entered_by = {tv_fixer} where round_id = {p_round}');
select pg_temp.check('tv_staff', 'correct a score (not allowed to)','blocked','update scores set strokes = 4, entered_by = {tv_staff} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_staff', 'see the week',              'some', 'select 1 from rounds where id = {tv_round}');

-- ------------------------------------------------------------ the scoring rotation, unchanged

select pg_temp.check('tv_p1', 'score the player they keep',   'works', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 4, {tv_p1})');
select pg_temp.check('tv_p1', 'score themself',               'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p1}, 2, 4, {tv_p1})');
select pg_temp.check('tv_p1', 'score somebody else',          'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p3}, 2, 4, {tv_p1})');
select pg_temp.check('tv_p1', 'score a PukaGolf player',      'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({p_round}, {p_player}, 9, 4, {tv_p1})');
select pg_temp.check('p_player', 'score the player they keep','works', 'insert into scores (round_id, player_id, hole, strokes, entered_by) select {p_round}, {p_scored}, coalesce(max(hole), 0) + 1, 4, {p_player} from scores where round_id = {p_round} and player_id = {p_scored}');
select pg_temp.check('p_player', 'score in Test Valley',      'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 4, {p_player})');

-- ------------------------------------------------------------ joining a club

select pg_temp.check('nina',     'ask to join Test Valley',              'works',   $$select club_request_join('test-valley')$$);
select pg_temp.check('anon',     'ask to join without an account',       'refused', $$select club_request_join('test-valley')$$);
select pg_temp.check('nina',     'ask to join a club that isn''t there', 'refused', $$select club_request_join('no-such-club')$$);

-- Nina's request, waiting; and a recent removal from PukaGolf.
insert into club_members (club_id, profile_id, role, status, requested_at)
values ('c1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000008', 'player', 'requested', now());
insert into club_members (club_id, profile_id, role, status, requested_at, decided_at)
values ('a0000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000008', 'player', 'removed', now(), now());

select pg_temp.check('nina',     'the club while still waiting',         'none',    'select 1 from rounds where id = {tv_round}');
select pg_temp.check('nina',     'their own request',                    'some',    $$select 1 where my_club_request('test-valley') = 'requested'$$);
select pg_temp.check('nina',     'ask again straight after removal',     'refused', $$select club_request_join('pukagolf')$$);
select pg_temp.check('tv_admin', 'the request, on their admin page',     'some',    $$select 1 from jsonb_array_elements(club_admin_overview({tv_club})->'members') m where m->>'id' = {nina}::text and m->>'status' = 'requested'$$);
select pg_temp.check('tv_staff', 'approve it (admins only)',             'refused', 'select club_decide({tv_club}, {nina}, true)');
select pg_temp.check('nina',     'approve themself',                     'refused', 'select club_decide({tv_club}, {nina}, true)');
select pg_temp.check('p_admin',  'approve it from PukaGolf',             'refused', 'select club_decide({tv_club}, {nina}, true)');
select pg_temp.check('tv_admin', 'approve it',                           'works',   'select club_decide({tv_club}, {nina}, true)');
select pg_temp.check('tv_admin', 'decline it',                           'works',   'select club_decide({tv_club}, {nina}, false)');

-- ------------------------------------------------------------ adding members

select pg_temp.check('tv_admin', 'add Nina by her number',               'works',   $$select club_add_member({tv_club}, '(239) 555-0199', 'player')$$);
select pg_temp.check('tv_admin', 'add a number nobody signed up with',   'none',    $$select 1 where club_add_member({tv_club}, '(239) 555-0100', 'player') is not null$$);
select pg_temp.check('tv_admin', 'test 61 numbers in an hour',           'refused', $$select pg_temp.add_numbers({tv_club}, 61)$$);
select pg_temp.check('tv_admin', 'test 60 numbers in an hour',           'works',   $$select pg_temp.add_numbers({tv_club}, 60)$$);
select pg_temp.check('tv_admin', 'add Nina to PukaGolf',                 'refused', $$select club_add_member({puka_club}, '(239) 555-0199', 'player')$$);
select pg_temp.check('p_admin',  'add Nina to Test Valley',              'refused', $$select club_add_member({tv_club}, '(239) 555-0199', 'player')$$);
select pg_temp.check('tv_fixer', 'add Nina (admins only)',               'refused', $$select club_add_member({tv_club}, '(239) 555-0199', 'player')$$);

-- ------------------------------------------------------------ roles

select pg_temp.check('tv_admin', 'make a player staff',                  'works',   $$select club_set_role({tv_club}, {tv_p1}, 'staff')$$);
select pg_temp.check('tv_p1',    'make themself an admin',               'refused', $$select club_set_role({tv_club}, {tv_p1}, 'admin')$$);
select pg_temp.check('tv_fixer', 'change a role (admins only)',          'refused', $$select club_set_role({tv_club}, {tv_p1}, 'staff')$$);
select pg_temp.check('p_admin',  'change a TV role',                     'refused', $$select club_set_role({tv_club}, {tv_p1}, 'admin')$$);
select pg_temp.check('tv_admin', 'step down as the only admin',          'refused', $$select club_set_role({tv_club}, {tv_admin}, 'player')$$);
select pg_temp.check('tv_admin', 'let staff fix scores',                 'works',   'select club_set_staff_scores({tv_club}, {tv_staff}, true)');
select pg_temp.check('tv_admin', 'give a player the staff setting',      'refused', 'select club_set_staff_scores({tv_club}, {tv_p2}, true)');
select pg_temp.check('p_admin',  'switch a TV staff member''s setting',  'refused', 'select club_set_staff_scores({tv_club}, {tv_staff}, true)');
select pg_temp.check('tv_admin', 'remove a player',                      'works',   'select club_remove_member({tv_club}, {tv_p3})');
select pg_temp.check('tv_admin', 'remove themself as the only admin',    'refused', 'select club_remove_member({tv_club}, {tv_admin})');
select pg_temp.check('tv_admin', 'remove Sam from PukaGolf',             'refused', 'select club_remove_member({puka_club}, {sam})');
select pg_temp.check('p_admin',  'remove a TV player',                   'refused', 'select club_remove_member({tv_club}, {tv_p1})');

-- ------------------------------------------------------------ leagues

select pg_temp.check('tv_admin', 'start a league',                       'works',   $$select league_create({tv_club}, 'Wednesday Nights')$$);
select pg_temp.check('tv_p1',    'start a league (admins only)',         'refused', $$select league_create({tv_club}, 'Wednesday Nights')$$);
select pg_temp.check('p_admin',  'start a league in TV',                 'refused', $$select league_create({tv_club}, 'Wednesday Nights')$$);
select pg_temp.check('tv_p1',    'ask to play on Sundays',               'works',   'select league_request_join({tv_league2})');
select pg_temp.check('tv_p1',    'ask to play in PukaGolf''s league',    'refused', 'select league_request_join({saturday})');
select pg_temp.check('nina',     'ask for a league before joining',      'refused', 'select league_request_join({tv_league})');
select pg_temp.check('tv_admin', 'put a member in a league',             'works',   'select league_set_member({tv_league2}, {tv_p1}, true)');
select pg_temp.check('tv_admin', 'put a non-member in a league',         'refused', 'select league_set_member({tv_league2}, {nina}, true)');
select pg_temp.check('tv_admin', 'put Sam in PukaGolf''s league',        'refused', 'select league_set_member({saturday}, {sam}, true)');
select pg_temp.check('p_admin',  'put a TV member in a TV league',       'refused', 'select league_set_member({tv_league2}, {tv_p1}, true)');

select pg_temp.check('tv_p1',    'the Sunday league, to ask for',        'some',    $$select 1 from jsonb_array_elements(club_league_choices({tv_club})) l where l->>'name' = 'Test Valley Sunday'$$);
select pg_temp.check('tv_p1',    'PukaGolf''s leagues, to ask for',      'none',    $$select 1 from jsonb_array_elements(club_league_choices({puka_club}))$$);
select pg_temp.check('nina',     'TV''s leagues before joining',         'none',    $$select 1 from jsonb_array_elements(club_league_choices({tv_club}))$$);

-- ------------------------------------------------------------ the club admin's page

select pg_temp.check('tv_admin', 'own club''s admin page',               'works',   'select club_admin_overview({tv_club})');
select pg_temp.check('p_admin',  'own club''s admin page',               'works',   'select club_admin_overview({puka_club})');
select pg_temp.check('p_admin',  'TV''s admin page',                     'refused', 'select club_admin_overview({tv_club})');
select pg_temp.check('tv_admin', 'PukaGolf''s admin page',               'refused', 'select club_admin_overview({puka_club})');
select pg_temp.check('tv_fixer', 'the admin page (admins only)',         'refused', 'select club_admin_overview({tv_club})');

-- ------------------------------------------------------------ the platform admin's page

select pg_temp.check('p_owner',  'every club',                           'works',   'select platform_clubs()');
select pg_temp.check('p_admin',  'every club',                           'refused', 'select platform_clubs()');
select pg_temp.check('p_owner',  'create a club',                        'works',   $$select platform_create_club('qa-club', 'QA Club', true, null)$$);
select pg_temp.check('p_owner',  'create a club at a taken address',     'refused', $$select platform_create_club('test-valley', 'Again', false, null)$$);
select pg_temp.check('tv_admin', 'create a club',                        'refused', $$select platform_create_club('qa-club', 'QA Club', true, null)$$);
select pg_temp.check('p_owner',  'close a club',                         'works',   $$select platform_set_club_status({tv_club}, 'closed')$$);
select pg_temp.check('tv_admin', 'close their own club',                 'refused', $$select platform_set_club_status({tv_club}, 'closed')$$);
select pg_temp.check('p_owner',  'TV, marked as seen from outside',      'some',    $$select 1 from jsonb_array_elements(my_clubs()) c where c->>'slug' = 'test-valley' and (c->>'viaPlatform')::boolean$$);
select pg_temp.check('p_owner',  'note looking at TV',                   'works',   'select platform_note_view({tv_club})');

-- ------------------------------------------------------------ every league runs itself

select pg_temp.check('tv_admin', 'own league''s admin page',             'works',   'select owner_league_overview({tv_league})');
select pg_temp.check('tv_admin', 'carry Thursday forward a week',        'works',   $$select owner_start_new_week({tv_league}, 'Week 2', current_date + 7)$$);
select pg_temp.check('tv_admin', 'a first week with no course',          'refused', $$select owner_start_new_week({tv_league3}, 'First week', current_date)$$);
select pg_temp.check('tv_admin', 'a first week on their course',         'works',   $$select owner_start_new_week({tv_league3}, 'First week', current_date, true, {tv_course})$$);
select pg_temp.check('tv_admin', 'a first week on PukaGolf''s course',   'refused', $$select owner_start_new_week({tv_league3}, 'First week', current_date, true, (select course_id from rounds where id = {p_round}))$$);
select pg_temp.check('p_admin',  'start a TV week',                      'refused', $$select owner_start_new_week({tv_league}, 'Week 2', current_date + 7)$$);

select pg_temp.check('tv_admin', 'set own league''s rules',              'works',   $$select owner_set_league_rules({tv_league}, array[10, 8, 6], 1, 0, 0, 'gross', false, 0, 'stroke', null)$$);
select pg_temp.check('p_admin',  'set TV''s rules',                      'refused', $$select owner_set_league_rules({tv_league}, array[10, 8, 6], 1, 0, 0, 'gross', false, 0, 'stroke', null)$$);
select pg_temp.check('tv_admin', 'set PukaGolf''s rules',                'refused', $$select owner_set_league_rules({saturday}, array[10, 8, 6], 1, 0, 0, 'gross', false, 0, 'stroke', null)$$);
select pg_temp.check('tv_admin', 'skins on in own league',               'works',   'select owner_set_league_skins({tv_league}, true)');
select pg_temp.check('p_admin',  'skins on in TV''s league',             'refused', 'select owner_set_league_skins({tv_league}, true)');
select pg_temp.check('tv_admin', 'own league''s first tee',              'works',   $$select admin_set_tee_defaults({tv_league}, '07:30', 9)$$);
select pg_temp.check('tv_admin', 'own league''s announcement',           'works',   $$select admin_set_announcement({tv_league}, 'Shotgun start')$$);
select pg_temp.check('tv_admin', 'close own league''s season',           'works',   'select owner_close_season({tv_league}, 2026, null)');
select pg_temp.check('p_admin',  'close TV''s season',                   'refused', 'select owner_close_season({tv_league}, 2026, null)');
select pg_temp.check('tv_admin', 'an event in own league',               'works',   $$select owner_create_league_event({tv_league}, 'TV Medal', current_date + 3)$$);
select pg_temp.check('p_admin',  'an event in TV''s league',             'refused', $$select owner_create_league_event({tv_league}, 'TV Medal', current_date + 3)$$);

select pg_temp.check('tv_p1',    'own league''s rules',                  'some',    'select 1 from league_rules where league_id = {tv_league}');
select pg_temp.check('tv_p1',    'PukaGolf''s rules',                    'none',    'select 1 from league_rules where league_id = {saturday}');
select pg_temp.check('p_player', 'Saturday''s rules, kept as they were', 'some',    $$select 1 from league_rules where league_id = {saturday} and ranking = 'net' and skins_enabled$$);
select pg_temp.check('tv_admin', 'a new league starts standard',         'some',    $$select 1 from league_rules where league_id = {tv_league3} and ranking = 'gross' and not skins_enabled and default_game = 'stroke'$$);

select pg_temp.check('tv_admin', 'import a course into own club',        'works',   $$select import_course('{"name": "Imported", "hole_count": 9, "external_id": "ext-1", "holes": [], "tees": []}'::jsonb, {tv_club})$$);
select pg_temp.check('p_admin',  'import a course into TV',              'refused', $$select import_course('{"name": "Imported", "hole_count": 9, "external_id": "ext-1", "holes": [], "tees": []}'::jsonb, {tv_club})$$);
select pg_temp.check('p_admin',  'the simulator weight (platform''s)',   'refused', 'select owner_set_simulator_weight(0.3)');
select pg_temp.check('p_owner',  'the simulator weight',                 'works',   'select owner_set_simulator_weight(0.3)');

-- ------------------------------------------------------------ scoring modes

select pg_temp.check('tv_admin', 'choose Self Scoring',                  'works',   $$select league_set_scoring_mode({tv_league}, 'self')$$);
select pg_temp.check('tv_fixer', 'choose the mode (admins only)',        'refused', $$select league_set_scoring_mode({tv_league}, 'self')$$);
select pg_temp.check('p_admin',  'choose TV''s mode',                    'refused', $$select league_set_scoring_mode({tv_league}, 'self')$$);
select pg_temp.check('tv_admin', 'a mode that doesn''t exist',           'refused', $$select league_set_scoring_mode({tv_league}, 'honour')$$);

update league_rules set scoring_mode = 'self' where league_id = 'c2000000-0000-4000-8000-000000000001';

select pg_temp.check('tv_p1',    'Self: score themself',                 'works',   'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p1}, 2, 4, {tv_p1})');
select pg_temp.check('tv_p1',    'Self: score their old partner',        'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 4, {tv_p1})');

update league_rules set scoring_mode = 'team' where league_id = 'c2000000-0000-4000-8000-000000000001';

select pg_temp.check('tv_p1',    'Team: score anyone in the group',      'works',   'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p3}, 2, 4, {tv_p1})');
select pg_temp.check('tv_p1',    'Team: score themself',                 'works',   'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p1}, 2, 4, {tv_p1})');
select pg_temp.check('p_player', 'Team: change a TV group''s score',     'blocked', 'update scores set strokes = 2, entered_by = {p_player} where round_id = {tv_round} and player_id = {tv_p3}');

update league_rules set scoring_mode = 'partner' where league_id = 'c2000000-0000-4000-8000-000000000001';

select pg_temp.check('tv_p1',    'Partner again: themself',              'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p1}, 2, 4, {tv_p1})');

-- ------------------------------------------------------------ a keeper with no login

-- Gus has no login and is given Val Two's card, so nobody could ever keep it.
insert into profiles (id, full_name, is_guest)
values ('c4000000-0000-4000-8000-000000000009', 'Gus Guest', true);
insert into cast_ids values ('gus', 'c4000000-0000-4000-8000-000000000009');
insert into tee_time_players (tee_time_id, round_id, player_id, position)
values ('c6000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001',
        'c4000000-0000-4000-8000-000000000009', 4);
update scorer_assignments set scorer_player_id = 'c4000000-0000-4000-8000-000000000009'
 where tee_time_id = 'c6000000-0000-4000-8000-000000000001'
   and scored_player_id = 'c4000000-0000-4000-8000-000000000005';

select pg_temp.check('tv_p2',    'own card when the keeper can''t sign in','works',  'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 4, {tv_p2})');
select pg_temp.check('tv_p2',    '... and still the card they keep',     'works',   'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p3}, 2, 4, {tv_p2})');
select pg_temp.check('tv_p3',    'own card, keeper can sign in',         'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p3}, 2, 4, {tv_p3})');
select pg_temp.check('tv_p1',    'the card Gus took over',               'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 4, {tv_p1})');
select pg_temp.check('p_player', 'a TV card with a no-login keeper',     'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 4, {p_player})');
select pg_temp.check('tv_p1',    'who in the week has no login',         'some',    'select 1 where {gus} = any(round_players_without_login({tv_round}))');
select pg_temp.check('p_player', 'who in TV''s week has no login',       'none',    'select 1 where cardinality(round_players_without_login({tv_round})) > 0');

update scorer_assignments set scorer_player_id = 'c4000000-0000-4000-8000-000000000004'
 where tee_time_id = 'c6000000-0000-4000-8000-000000000001'
   and scored_player_id = 'c4000000-0000-4000-8000-000000000005';
delete from tee_time_players where player_id = 'c4000000-0000-4000-8000-000000000009';

-- ------------------------------------------------------------ an admin's own card

-- Tess, the admin, and Fiona, staff who fix scores, both play this week, in
-- a group of their own with nobody keeping their cards.
insert into tee_times (id, round_id, tee_at, starting_hole)
values ('c6000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', now(), 1);
insert into tee_time_players (tee_time_id, round_id, player_id, position) values
  ('c6000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 0),
  ('c6000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 1);

select pg_temp.check('tv_admin', 'Partner: post own score as admin',     'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_admin}, 1, 4, {tv_admin})');
select pg_temp.check('tv_fixer', 'Partner: post own score as staff',     'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_fixer}, 1, 4, {tv_fixer})');
select pg_temp.check('tv_admin', 'still fix a player''s card',           'works',   'update scores set strokes = 4, entered_by = {tv_admin} where round_id = {tv_round} and player_id = {tv_p2}');

update league_rules set scoring_mode = 'self' where league_id = 'c2000000-0000-4000-8000-000000000001';

select pg_temp.check('tv_admin', 'Self: post own score as admin',        'works',   'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_admin}, 1, 4, {tv_admin})');

update league_rules set scoring_mode = 'partner' where league_id = 'c2000000-0000-4000-8000-000000000001';
delete from tee_time_players where tee_time_id = 'c6000000-0000-4000-8000-000000000002';
delete from tee_times where id = 'c6000000-0000-4000-8000-000000000002';

-- ------------------------------------------------------------ the Groups page

-- Val One also plays Sundays; nobody else here does.
insert into league_members (league_id, profile_id, status, decided_at)
values ('c2000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000004', 'active', now());

select pg_temp.check('tv_admin', 'Groups: the league''s own member',     'some',    $$select 1 from jsonb_array_elements(admin_week_groups({tv_round2})->'others') o where o->>'id' = {tv_p1}::text$$);
select pg_temp.check('tv_admin', 'Groups: another club''s golfer',       'none',    $$select 1 from jsonb_array_elements(admin_week_groups({tv_round2})->'others') o where o->>'id' in ({p_player}::text, {p_admin}::text)$$);
select pg_temp.check('tv_admin', 'Groups: own club, other league',       'none',    $$select 1 from jsonb_array_elements(admin_week_groups({tv_round2})->'others') o where o->>'id' in ({tv_p2}::text, {sam}::text)$$);
select pg_temp.check('tv_admin', 'Groups: nobody outside the league',    'none',    $$select 1 from jsonb_array_elements(admin_week_groups({tv_round2})->'others') o where o->>'id' <> {tv_p1}::text$$);
select pg_temp.check('tv_admin', 'Groups: no-answer counts the league',  'some',    $$select 1 where (admin_week_groups({tv_round2})->'rsvp'->>'noAnswer')::integer = 1$$);
select pg_temp.check('p_admin',  'Groups: TV''s week',                   'refused', 'select admin_week_groups({tv_round2})');

delete from league_members
 where league_id = 'c2000000-0000-4000-8000-000000000002'
   and profile_id = 'c4000000-0000-4000-8000-000000000004';

-- Editing a player: a number another club's golfer uses is refused without
-- naming them; one an own member uses names them, as before.
update profiles set phone = '+12395550177' where id = (select id from cast_ids where who = 'p_player');
update profiles set phone = '+12395550178' where id = 'c4000000-0000-4000-8000-000000000005';

select pg_temp.check('tv_admin', 'a number another club''s golfer uses', 'some',    $$select 1 where pg_temp.message_of($q$select owner_update_player('c4000000-0000-4000-8000-000000000004', 'Val One', '+12395550177')$q$) = 'Another golfer already uses that number.'$$);
select pg_temp.check('tv_admin', 'a number an own member uses',          'some',    $$select 1 where pg_temp.message_of($q$select owner_update_player('c4000000-0000-4000-8000-000000000004', 'Val One', '+12395550178')$q$) = 'Val Two already uses that number.'$$);

-- A champion from the league, never a golfer from another club.
select pg_temp.check('tv_admin', 'close a season, own player champion',  'works',   'select owner_close_season({tv_league}, 2030, {tv_p1})');
select pg_temp.check('tv_admin', 'close a season, other club''s champion','refused', 'select owner_close_season({tv_league}, 2030, {p_player})');

-- ------------------------------------------------------------ standings

select pg_temp.check('tv_admin', 'count live weeks in the standings',    'works',   $$select league_set_standings_count({tv_league}, 'live')$$);
select pg_temp.check('tv_fixer', 'standings setting (admins only)',      'refused', $$select league_set_standings_count({tv_league}, 'live')$$);
select pg_temp.check('p_admin',  'TV''s standings setting',              'refused', $$select league_set_standings_count({tv_league}, 'live')$$);
select pg_temp.check('tv_admin', 'a standings setting that isn''t one',  'refused', $$select league_set_standings_count({tv_league}, 'sometimes')$$);
select pg_temp.check('tv_p1',    'final weeks only, unless chosen',      'some',    $$select 1 from league_rules where league_id = {tv_league} and standings_count = 'final'$$);

-- ------------------------------------------------------------ locked cards

insert into card_locks (round_id, player_id)
values ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005');

select pg_temp.check('tv_p1',    'change the locked card they keep',     'blocked', 'update scores set strokes = 3, entered_by = {tv_p1} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_p1',    'add to the locked card they keep',     'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 4, {tv_p1})');
select pg_temp.check('tv_fixer', 'fix a locked card (staff)',            'blocked', 'update scores set strokes = 3, entered_by = {tv_fixer} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_admin', 'fix a locked card with no reason',     'blocked', 'update scores set strokes = 3, entered_by = {tv_admin} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_admin', 'fix a locked card, saying why',        'works',   $$select admin_fix_signed_score({tv_round}, {tv_p2}, 1, 3, 'Card misread at the turn')$$);
select pg_temp.check('tv_admin', 'a reason of nothing',                  'refused', $$select admin_fix_signed_score({tv_round}, {tv_p2}, 1, 3, '   ')$$);
select pg_temp.check('tv_admin', 'the reason is in the card''s history', 'some',    $$select 1 from pg_temp.fix_and_read({tv_round}, {tv_p2}, 'Card misread') e where e->>'reason' = 'Card misread' and e->>'cardWas' = 'signed_off'$$);
select pg_temp.check('tv_fixer', 'a locked card, with a reason (staff)', 'refused', $$select admin_fix_signed_score({tv_round}, {tv_p2}, 1, 3, 'Card misread')$$);
select pg_temp.check('p_admin',  'TV''s locked card, with a reason',     'refused', $$select admin_fix_signed_score({tv_round}, {tv_p2}, 1, 3, 'Card misread')$$);
select pg_temp.check('tv_admin', 'the reason route on an open card',     'refused', $$select admin_fix_signed_score({tv_round}, {tv_p3}, 1, 3, 'Card misread')$$);

-- A card an admin locked says so, not that the group signed it.
update card_locks set how = 'admin'
 where round_id = 'c5000000-0000-4000-8000-000000000001'
   and player_id = 'c4000000-0000-4000-8000-000000000005';
select pg_temp.check('tv_admin', 'history says an admin locked it',      'some',    $$select 1 from pg_temp.fix_and_read({tv_round}, {tv_p2}, 'Admin lock fix') e where e->>'reason' = 'Admin lock fix' and e->>'cardWas' = 'locked'$$);
update card_locks set how = 'signed'
 where round_id = 'c5000000-0000-4000-8000-000000000001'
   and player_id = 'c4000000-0000-4000-8000-000000000005';

-- Cleared scores that can come back: the club's admin may see them.
select pg_temp.check('tv_admin', 'weeks whose cleared scores can return', 'works',   'select owner_restorable_scores()');
select pg_temp.check('anon',     'cleared scores, signed out',           'refused', 'select owner_restorable_scores()');
select pg_temp.check('p_admin',  'fix TV''s locked card',                'blocked', 'update scores set strokes = 3, entered_by = {p_admin} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_admin', 'lock a card',                          'works',   'select admin_set_card_lock({tv_round}, {tv_p3}, true)');
select pg_temp.check('tv_admin', 'unlock a card',                        'works',   'select admin_set_card_lock({tv_round}, {tv_p2}, false)');
select pg_temp.check('tv_fixer', 'lock a card (admins only)',            'refused', 'select admin_set_card_lock({tv_round}, {tv_p3}, true)');
select pg_temp.check('p_admin',  'lock a TV card',                       'refused', 'select admin_set_card_lock({tv_round}, {tv_p3}, true)');
select pg_temp.check('tv_p1',    'the card shows it is locked',          'some',    'select 1 from card_locks where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('p_player', 'TV''s locks',                          'none',    'select 1 from card_locks where round_id = {tv_round}');

delete from card_locks where round_id = 'c5000000-0000-4000-8000-000000000001';

select pg_temp.check('tv_p1',    'sign off cards that aren''t finished', 'refused', 'select sign_off_group({tv_tee})');

-- Every card in the group finished: holes 2 to 9.
insert into scores (round_id, player_id, hole, strokes, entered_by)
select 'c5000000-0000-4000-8000-000000000001', p, h, 4, 'c4000000-0000-4000-8000-000000000001'
  from unnest(array['c4000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-000000000005',
                    'c4000000-0000-4000-8000-000000000006', 'c4000000-0000-4000-8000-000000000007']::uuid[]) p,
       generate_series(2, 9) h;

select pg_temp.check('tv_p1',    'sign off their group''s cards',        'works',   'select sign_off_group({tv_tee})');
select pg_temp.check('tv_p1',    'a signed card records who signed',     'some',    $$select 1 from pg_temp.sign_and_read({tv_tee}) r where r.how = 'signed' and r.locked_by = {tv_p1} having count(*) = 4$$);
select pg_temp.check('p_player', 'sign off a TV group''s cards',         'refused', 'select sign_off_group({tv_tee})');

-- A score on a signed card is refused in words: locked, by whom (0056).
insert into card_locks (round_id, player_id, how, locked_by)
values ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005', 'signed', 'c4000000-0000-4000-8000-000000000004');

select pg_temp.check('tv_p1',    'a locked card says who signed it',     'some',    $$select 1 where pg_temp.message_of($q$insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 3, {tv_p1}) on conflict (round_id, player_id, hole) do update set strokes = excluded.strokes, entered_by = excluded.entered_by$q$) like 'The card is locked: signed off by Val One, %'$$);
select pg_temp.check('p_admin',  'another club''s lock isn''t described', 'none',    $$select 1 where pg_temp.message_of($q$insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 3, {p_admin}) on conflict (round_id, player_id, hole) do update set strokes = excluded.strokes, entered_by = excluded.entered_by$q$) ilike '%locked%'$$);

delete from card_locks where round_id = 'c5000000-0000-4000-8000-000000000001';

-- A week marked final locks every card in it.
update rounds set status = 'final' where id = 'c5000000-0000-4000-8000-000000000001';

select pg_temp.check('tv_p1',    'change a card in a final week',        'blocked', 'update scores set strokes = 3, entered_by = {tv_p1} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_admin', 'change a final week, no reason',       'blocked', 'update scores set strokes = 3, entered_by = {tv_admin} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_admin', 'change a final week, saying why',      'works',   $$select admin_fix_signed_score({tv_round}, {tv_p2}, 1, 3, 'Scorer added wrong')$$);
select pg_temp.check('tv_admin', 'history says the week was final',      'some',    $$select 1 from pg_temp.fix_and_read({tv_round}, {tv_p2}, 'Final fix') e where e->>'reason' = 'Final fix' and e->>'cardWas' = 'week_final'$$);

update rounds set status = 'live' where id = 'c5000000-0000-4000-8000-000000000001';
delete from card_locks where round_id = 'c5000000-0000-4000-8000-000000000001';

-- ------------------------------------------------------------ a group's sign-off, taken back whole (0057)

-- Two cards the group signed, one the pro shop locked.
insert into card_locks (round_id, player_id, how, locked_by) values
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000004', 'signed', 'c4000000-0000-4000-8000-000000000004'),
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005', 'signed', 'c4000000-0000-4000-8000-000000000004'),
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000006', 'admin',  'c4000000-0000-4000-8000-000000000001');

select pg_temp.check('tv_admin', 'take back a group''s sign-off',        'works',   'select admin_take_back_sign_off({tv_round}, {tv_p2})');
select pg_temp.check('tv_admin', 'it frees the group, not an admin lock', 'some',   $$select 1 where pg_temp.take_back_and_read({tv_round}, {tv_p2}) = 'signed:0 admin:1'$$);
select pg_temp.check('tv_fixer', 'take back a sign-off (admins only)',   'refused', 'select admin_take_back_sign_off({tv_round}, {tv_p2})');
select pg_temp.check('tv_p1',    'take back their own group''s sign-off', 'refused', 'select admin_take_back_sign_off({tv_round}, {tv_p2})');
select pg_temp.check('p_admin',  'take back a TV group''s sign-off',     'refused', 'select admin_take_back_sign_off({tv_round}, {tv_p2})');
select pg_temp.check('anon',     'take back a sign-off, signed out',     'refused', 'select admin_take_back_sign_off({tv_round}, {tv_p2})');
select pg_temp.check('tv_admin', 'clearing a week opens its cards',      'some',    'select 1 where pg_temp.clear_and_count({tv_round}) = 0');
select pg_temp.check('p_admin',  'clear TV''s week',                     'refused', 'select owner_clear_round_scores({tv_round})');

delete from card_locks where round_id = 'c5000000-0000-4000-8000-000000000001';

-- A week going final is logged, with its unfinished cards, in its own club's log.
select pg_temp.check('tv_admin', 'a week gone final is in the log',      'some',    $$select 1 from pg_temp.final_and_read({tv_round}, {tv_club}) e where e->'detail' ? 'unfinished' and e->'detail' ? 'short'$$);
select pg_temp.check('p_admin',  'mark TV''s week final',                'blocked', $$select 1 from pg_temp.final_and_read({tv_round}, {puka_club})$$);

-- The phone's time on a hole that waited, in the card's history.
select pg_temp.check('tv_p1',    'send a hole with the phone''s time',   'works',   $$insert into scores (round_id, player_id, hole, strokes, entered_by, entered_on_phone_at) values ({tv_round}, {tv_p2}, 1, 5, {tv_p1}, now() - interval '20 minutes') on conflict (round_id, player_id, hole) do update set strokes = excluded.strokes, entered_by = excluded.entered_by, entered_on_phone_at = excluded.entered_on_phone_at$$);

-- ------------------------------------------------------------ one card in a final week (0058)

insert into card_locks (round_id, player_id, how, locked_by) values
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005', 'signed', 'c4000000-0000-4000-8000-000000000004');

select pg_temp.check('tv_admin', 'take back a final week''s sign-off, with a reason', 'some',    $$select 1 where pg_temp.final_take_back({tv_round}, {tv_p2}, 'signed by mistake') = 1$$);
select pg_temp.check('tv_admin', 'take back a final week''s sign-off, no reason',     'refused', $$select pg_temp.final_take_back({tv_round}, {tv_p2}, null)$$);
select pg_temp.check('tv_admin', 'the reason is kept in the club''s log',             'some',    $$select 1 where pg_temp.final_take_back_reason({tv_round}, {tv_p2}, {tv_club}, 'signed by mistake') = 'signed by mistake'$$);
select pg_temp.check('p_admin',  'take back a TV final week''s sign-off',             'refused', $$select admin_take_back_sign_off({tv_round}, {tv_p2}, 'not my club')$$);
select pg_temp.check('tv_fixer', 'take back a final week''s sign-off (staff)',        'refused', $$select admin_take_back_sign_off({tv_round}, {tv_p2}, 'staff')$$);

delete from card_locks where round_id = 'c5000000-0000-4000-8000-000000000001';

-- The double-par cap, and rules saves that log only what changed.
select pg_temp.check('tv_admin', 'turn off the double-par cap',          'works',   'select league_set_double_par_cap({tv_league}, false)');
select pg_temp.check('p_admin',  'turn off TV''s double-par cap',        'refused', 'select league_set_double_par_cap({tv_league}, false)');
select pg_temp.check('tv_p1',    'turn off the double-par cap (player)', 'refused', 'select league_set_double_par_cap({tv_league}, false)');
select pg_temp.check('anon',     'turn off the cap, signed out',         'refused', 'select league_set_double_par_cap({tv_league}, false)');
select pg_temp.check('tv_p1',    'read own league''s cap',               'some',    'select 1 from league_rules where league_id = {tv_league} and double_par_cap');
select pg_temp.check('p_player', 'read TV''s cap',                       'none',    'select 1 from league_rules where league_id = {tv_league}');
select pg_temp.check('tv_admin', 'a rules save logs one line per change', 'some',   $$select 1 where pg_temp.rules_lines({tv_league}, {tv_club}, 'team') = 2$$);

-- ------------------------------------------------------------ the phone's time, and clearing a final week (0059)

update rounds set status = 'live' where id = 'c5000000-0000-4000-8000-000000000001';

select pg_temp.check('tv_admin', 'a hole sent at once has no phone time',   'none', $$select 1 where pg_temp.phone_at_of({tv_round}, {tv_p3}, {tv_club}, null) is not null$$);
select pg_temp.check('tv_admin', 'a hole that waited keeps its phone time', 'some', $$select 1 where pg_temp.phone_at_of({tv_round}, {tv_p3}, {tv_club}, now() - interval '5 minutes') is not null$$);
select pg_temp.check('tv_admin', 'corrected at once, no phone time again',  'none', $$select 1 where pg_temp.phone_at_of({tv_round}, {tv_p3}, {tv_club}, null) is not null$$);

delete from scores
 where round_id = 'c5000000-0000-4000-8000-000000000001'
   and player_id = 'c4000000-0000-4000-8000-000000000006' and hole = 9;

-- A past, final week of Test Valley's, while Week 1 is Live.
insert into rounds (id, league_id, name, played_on, hole_count, status, course_id)
values ('c5000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000001',
        'Test Valley Week 0', current_date - 7, 9, 'final', 'c3000000-0000-4000-8000-000000000001');

select pg_temp.check('tv_admin', 'clear a final week with another one Live: stays final', 'some', $$select 1 where pg_temp.clear_status('c5000000-0000-4000-8000-000000000009') = 'final'$$);
update rounds set status = 'final' where id = 'c5000000-0000-4000-8000-000000000001';
select pg_temp.check('tv_admin', 'clear a final week with none Live: back to Live',      'some', $$select 1 where pg_temp.clear_status('c5000000-0000-4000-8000-000000000009') = 'live'$$);
select pg_temp.check('p_admin',  'clear TV''s past week',                                 'refused', $$select owner_clear_round_scores('c5000000-0000-4000-8000-000000000009')$$);

-- ------------------------------------------------------------ putting cleared scores back (0060)

-- Week 0 final with three holes each for two players, while Week 1 is Live.
update rounds set status = 'final' where id = 'c5000000-0000-4000-8000-000000000009';
update rounds set status = 'live'  where id = 'c5000000-0000-4000-8000-000000000001';
insert into scores (round_id, player_id, hole, strokes, entered_by)
select 'c5000000-0000-4000-8000-000000000009', p, h, 3 + h, p
  from unnest(array['c4000000-0000-4000-8000-000000000004',
                    'c4000000-0000-4000-8000-000000000005']::uuid[]) as p,
       generate_series(1, 3) as h
 order by p, h;

select pg_temp.check('tv_admin', 'put back a final week''s cleared scores',         'some', $$select 1 where pg_temp.put_back('c5000000-0000-4000-8000-000000000009', {tv_p1}, false) = '6/0/4/f'$$);
update rounds set status = 'final' where id = 'c5000000-0000-4000-8000-000000000001';
select pg_temp.check('tv_admin', 'put back after a new score: it keeps the new one', 'some', $$select 1 where pg_temp.put_back('c5000000-0000-4000-8000-000000000009', {tv_p1}, true) = '5/1/9/f'$$);
select pg_temp.check('p_admin',  'put back TV''s cleared scores',                    'refused', $$select owner_restore_scores('c5000000-0000-4000-8000-000000000009')$$);
select pg_temp.check('tv_admin', 'a rule set and set back logs both ways, once each', 'some', $$select 1 where pg_temp.drop_worst_lines({tv_league}, {tv_club}) = '0>1,1>0'$$);
select pg_temp.check('p_admin',  'TV''s rules log, from another club',               'refused', $$select pg_temp.drop_worst_lines({tv_league}, {tv_club})$$);

-- ------------------------------------------------------------ net changes, clear lines, one-tee courses (0061)

select pg_temp.check('tv_admin', 'a hole saved with the same number logs nothing', 'some', $$select 1 where pg_temp.same_then_new({tv_round}, {tv_p1}, {tv_club}) = 1$$);
select pg_temp.check('tv_admin', 'a clear''s lines say why, hole by hole',         'some', $$select 1 where pg_temp.clear_lines({tv_round}, {tv_club}) = 'reason, in order'$$);
select pg_temp.check('tv_p1',    'a one-tee course rates a round with no tee set', 'some', $$select 1 from jsonb_array_elements(player_rounds({tv_p1})) r where r->>'roundId' = {tv_round}::text and (r->>'courseRating')::numeric = 35.0$$);
select pg_temp.check('anon',     'the course''s only tee, signed out',             'refused', $$select only_tee({tv_course})$$);

delete from scores where round_id = 'c5000000-0000-4000-8000-000000000009';
delete from rounds where id = 'c5000000-0000-4000-8000-000000000009';
update rounds set status = 'live' where id = 'c5000000-0000-4000-8000-000000000001';

-- ------------------------------------------------------------ a closed season

insert into seasons (league_id, year, closed_at)
values ('c2000000-0000-4000-8000-000000000001', extract(year from current_date)::integer, now());

select pg_temp.check('tv_p1',    'change a card in a closed season',     'blocked', 'update scores set strokes = 3, entered_by = {tv_p1} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_fixer', 'fix a closed season''s card (staff)',  'blocked', 'update scores set strokes = 3, entered_by = {tv_fixer} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_admin', 'closed season, no reason',             'blocked', 'update scores set strokes = 3, entered_by = {tv_admin} where round_id = {tv_round} and player_id = {tv_p2}');
select pg_temp.check('tv_admin', 'closed season, saying why',            'works',   $$select admin_fix_signed_score({tv_round}, {tv_p2}, 1, 3, 'Late correction from the pro shop')$$);
select pg_temp.check('tv_admin', 'history says the season was closed',   'some',    $$select 1 from pg_temp.fix_and_read({tv_round}, {tv_p2}, 'Closed fix') e where e->>'reason' = 'Closed fix' and e->>'cardWas' = 'season_closed'$$);

-- The fix stays in the closed season's own trail. Run for real, rather than
-- through check(), so the trail can be read after it.
do $trail$
begin
  perform set_config('request.jwt.claim.sub', 'c4000000-0000-4000-8000-000000000001', true);
  perform set_config('request.jwt.claims',
                     '{"sub": "c4000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  perform admin_fix_signed_score('c5000000-0000-4000-8000-000000000001',
                                 'c4000000-0000-4000-8000-000000000005', 1, 4, 'Trail check');
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  insert into results (actor, label, expected, got)
  select 'tv_admin', 'the fix is in the season''s audit trail', 'some',
         case when exists (select 1 from audit_log
                            where entity = 'season' and action = 'score_fix'
                              and detail ->> 'reason' = 'Trail check'
                              and detail ->> 'league_id' = 'c2000000-0000-4000-8000-000000000001')
              then 'some' else 'none' end;
end;
$trail$;

delete from seasons where league_id = 'c2000000-0000-4000-8000-000000000001';

-- ------------------------------------------------------------ a card's history

select pg_temp.check('tv_admin', 'a card''s history',                    'some',    $$select 1 from jsonb_array_elements(card_history({tv_round}, {tv_p2}))$$);
select pg_temp.check('tv_fixer', 'a card''s history (admins only)',      'refused', 'select card_history({tv_round}, {tv_p2})');
select pg_temp.check('p_admin',  'a TV card''s history',                 'refused', 'select card_history({tv_round}, {tv_p2})');
select pg_temp.check('tv_p1',    'the site''s simulator weight',         'some',    $$select 1 where site_settings() ? 'simulatorWeight'$$);

-- ------------------------------------------------------------ handicaps on the day, time zones, the club's log (0054)

select pg_temp.check('tv_admin', 'score a week still being set up',      'refused', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round2}, {tv_p1}, 1, 4, {tv_admin})');
select pg_temp.check('tv_p1',    'their club''s time zone',              'some',    $$select 1 from jsonb_array_elements(my_clubs()) c where c->>'timeZone' = 'America/New_York'$$);
select pg_temp.check('tv_p1',    'when the other leagues play',          'some',    $$select 1 from jsonb_array_elements(club_league_choices({tv_club})) l where l ? 'day' and l ? 'firstTee' and l ? 'course'$$);
select pg_temp.check('p_player', 'when TV''s leagues play',              'none',    $$select 1 from jsonb_array_elements(club_league_choices({tv_club}))$$);

select pg_temp.check('tv_admin', 'their club''s audit log',              'some',    $$select 1 from jsonb_array_elements(club_audit_log({tv_club}, 200, null))$$);
select pg_temp.check('tv_admin', 'PukaGolf entries in TV''s log',        'none',    $$select 1 from jsonb_array_elements(club_audit_log({tv_club}, 200, null)) e where e->'detail'->>'round_id' = {p_round}::text or e->>'entityId' = {p_round}::text$$);
select pg_temp.check('tv_staff', 'the club''s audit log (admins only)',  'refused', 'select club_audit_log({tv_club}, 50, null)');
select pg_temp.check('tv_p1',    'the club''s audit log, as a player',   'refused', 'select club_audit_log({tv_club}, 50, null)');
select pg_temp.check('p_admin',  'TV''s audit log',                      'refused', 'select club_audit_log({tv_club}, 50, null)');
select pg_temp.check('p_admin',  'their own club''s audit log',          'works',   'select club_audit_log({puka_club}, 50, null)');
select pg_temp.check('anon',     'a club''s audit log, signed out',      'refused', 'select club_audit_log({tv_club}, 50, null)');

-- Marking the week final writes down everyone's handicap as it stands.
update rounds set status = 'final' where id = 'c5000000-0000-4000-8000-000000000001';

select pg_temp.check('tv_p1',    'their final week''s handicaps',        'some',    'select 1 from round_handicaps where round_id = {tv_round}');
select pg_temp.check('p_player', 'TV''s final week''s handicaps',        'none',    'select 1 from round_handicaps where round_id = {tv_round}');
select pg_temp.check('tv_admin', 'rewrite a frozen handicap',            'blocked', 'update round_handicaps set handicap_index = 1 where round_id = {tv_round}');
select pg_temp.check('tv_admin', 'add a frozen handicap',                'blocked', 'insert into round_handicaps (round_id, player_id, handicap_index) values ({tv_round}, {tv_p1}, 1)');

update rounds set status = 'live' where id = 'c5000000-0000-4000-8000-000000000001';

-- ------------------------------------------------------------ adding someone already in (0056)

update profiles set phone = '+12395550160' where id = 'c4000000-0000-4000-8000-000000000002';

select pg_temp.check('tv_admin', 're-adding a member says they''re in',  'some',    $$select 1 where pg_temp.message_of($q$select club_add_member({tv_club}, '2395550160', 'player')$q$) = 'Fiona Fixer is already in the club, as staff. Nothing was changed.'$$);
select pg_temp.check('tv_admin', 're-adding keeps their role',           'some',    $$select 1 from club_members where club_id = {tv_club} and profile_id = {tv_fixer} and role = 'staff' and staff_can_edit_scores$$);

-- ------------------------------------------------------------ an outing's weather, signed out (0056)

update events set latitude = 26.6, longitude = -81.9, share_token = 'tv-outing-weather-check'
 where id = 'c7000000-0000-4000-8000-000000000001';

select pg_temp.check('anon',     'an outing''s own place, by its link',  'some',    $$select 1 where api_outing_weather_place('tv-outing-weather-check', null) ->> 'latitude' = '26.6'$$);
select pg_temp.check('anon',     'a made-up outing link',                'some',    $$select 1 where api_outing_weather_place('not-a-real-link', null) is null$$);

-- ------------------------------------------------------------ signed out

select pg_temp.check('anon', 'any week',                      'none', 'select 1 from rounds');
select pg_temp.check('anon', 'any score',                     'none', 'select 1 from scores');
select pg_temp.check('anon', 'anyone',                        'none', 'select 1 from profiles');
select pg_temp.check('anon', 'any club',                      'none', 'select 1 from clubs');
select pg_temp.check('anon', 'the league''s events',          'refused', 'select league_events({saturday})');
select pg_temp.check('anon', 'add a score',                   'blocked', 'insert into scores (round_id, player_id, hole, strokes, entered_by) values ({tv_round}, {tv_p2}, 2, 4, {tv_p1})');

-- ------------------------------------------------------------ rations (0055)

select pg_temp.check('anon',     'a lookup, signed out',                 'refused', 'select api_lookup_allowed(null)');
select pg_temp.check('tv_p1',    'a lookup, signed in',                  'some',    'select 1 where api_lookup_allowed(null)');
select pg_temp.check('tv_p1',    '60 lookups in a minute',               'some',    'select 1 where pg_temp.lookups(60)');
select pg_temp.check('tv_p1',    '61 lookups in a minute',               'none',    'select 1 where pg_temp.lookups(61)');
select pg_temp.check('tv_p1',    '3 players, 120 lookups, one network',  'some',    $$select 1 where pg_temp.lookups_as(array[{tv_p1}, {tv_p2}, {tv_p3}], 40, '0123456789abcdef0123456789abcdef')$$);
select pg_temp.check('tv_p1',    '3 players, 123 lookups, one network',  'none',    $$select 1 where pg_temp.lookups_as(array[{tv_p1}, {tv_p2}, {tv_p3}], 41, '0123456789abcdef0123456789abcdef')$$);
select pg_temp.check('tv_p1',    '3 players, 123 lookups, made-up print', 'some',    $$select 1 where pg_temp.lookups_as(array[{tv_p1}, {tv_p2}, {tv_p3}], 41, 'not-a-fingerprint')$$);
select pg_temp.check('tv_p1',    'read the counts',                      'refused', 'select 1 from rate_limits');
select pg_temp.check('anon',     'read the counts, signed out',          'refused', 'select 1 from rate_limits');
select pg_temp.check('tv_p1',    'reset their own count',                'refused', 'delete from rate_limits');
select pg_temp.check('tv_p1',    'count a hit directly',                 'refused', $$select rate_limit_hit('x', 1, 60)$$);

-- ------------------------------------------------------------ the platform admin

select pg_temp.check('p_owner', 'Test Valley''s week',        'some', 'select 1 from rounds where id = {tv_round}');
select pg_temp.check('p_owner', 'PukaGolf''s week',           'some', 'select 1 from rounds where id = {p_round}');
select pg_temp.check('p_owner', 'the audit log',              'works', 'select owner_audit_log(50, null)');

-- ------------------------------------------------------------ the verdict

\o

\pset footer off
select n, actor, label, expected, got, coalesce(detail, '') as detail
  from results
 where got <> expected
 order by n;

select count(*) filter (where got = expected) as passed,
       count(*) filter (where got <> expected) as failed,
       count(*) as checks
  from results;

do $verdict$
declare
  failed integer;
begin
  select count(*) into failed from results where got <> expected;
  if failed > 0 then
    raise exception '% of the club isolation checks failed.', failed;
  end if;
end;
$verdict$;

rollback;
