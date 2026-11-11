-- Setup helpers.
--
-- The admin screens don't exist yet, so these do the same work from SQL: stand
-- up a course, then build a round with groups and a seeded scoring rotation
-- from whoever has signed up.

-- Create a course and its pars in one call.
--   select create_course('Pinehollow Municipal',
--                        array[4,4,4,5,4,4,3,4,4, 4,4,3,4,4,5,3,4,4]);
create or replace function create_course(course_name text, pars smallint[])
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  new_course uuid;
begin
  -- A null auth.uid() means there is no JWT at all, i.e. the SQL editor or the
  -- service role — the bootstrap path these helpers exist for. Execute is
  -- revoked from anon and authenticated below, so an API caller can never
  -- reach this with a null uid.
  if auth.uid() is not null and not is_admin() then
    raise exception 'Only an admin can create a course.';
  end if;

  insert into courses (name, hole_count)
  values (course_name, array_length(pars, 1))
  returning id into new_course;

  insert into course_holes (course_id, hole, par)
  select new_course, i, pars[i]
    from generate_series(1, array_length(pars, 1)) as i;

  return new_course;
end;
$fn$;

/*
  Build a round from everyone who has signed up.

  Players are split into groups of at most `group_size`, and scoring rotates
  within each: player[i] keeps player[i+1]'s card, wrapping. A trailing group of
  one cannot rotate, so it is merged into the previous group rather than left
  with nobody to score it.

    select build_round('Saturday Round 14', '<course-id>', 4);
*/
create or replace function build_round(
  round_name text,
  target_course uuid,
  group_size int default 4
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  new_round   uuid;
  holes       smallint;
  ids         uuid[];
  total       int;
  group_count int;
  first_tee   timestamptz := date_trunc('hour', now()) + interval '1 hour';
  g           int;
  lo          int;
  hi          int;
  members     uuid[];
  tee         uuid;
  i           int;
begin
  -- See the note in create_course: null uid means service role, not a player.
  if auth.uid() is not null and not is_admin() then
    raise exception 'Only an admin can build a round.';
  end if;

  if group_size < 2 then
    raise exception 'Groups need at least 2 players so scoring can rotate.';
  end if;

  select hole_count into holes from courses where id = target_course;
  if holes is null then
    raise exception 'No such course.';
  end if;

  select array_agg(id order by full_name) into ids from profiles;
  total := coalesce(array_length(ids, 1), 0);

  if total < 2 then
    raise exception 'Need at least 2 signed-up players; found %.', total;
  end if;

  insert into rounds (name, played_on, hole_count, status, course_id)
  values (round_name, current_date, holes, 'live', target_course)
  returning id into new_round;

  group_count := greatest(1, total / group_size);

  for g in 0 .. group_count - 1 loop
    lo := g * group_size + 1;
    hi := least((g + 1) * group_size, total);

    -- Absorb a trailing remainder that would otherwise be a group of one.
    if g = group_count - 1 then
      hi := total;
    end if;

    members := ids[lo:hi];

    insert into tee_times (round_id, tee_at, starting_hole)
    values (new_round, first_tee + (g * interval '10 minutes'), 1)
    returning id into tee;

    for i in 1 .. array_length(members, 1) loop
      insert into tee_time_players (tee_time_id, round_id, player_id, position)
      values (tee, new_round, members[i], i - 1);

      -- The ring: each player keeps the next player's card, last wraps to first.
      insert into scorer_assignments (tee_time_id, scored_player_id, scorer_player_id)
      values (
        tee,
        members[(i % array_length(members, 1)) + 1],
        members[i]
      );
    end loop;
  end loop;

  return new_round;
end;
$fn$;

-- Promote the first admin by email, since is_admin defaults to false.
--   select make_admin('you@example.com');
create or replace function make_admin(user_email text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $fn$
declare
  target uuid;
begin
  select id into target from auth.users where email = user_email;

  if target is null then
    raise exception 'No user signed up with %.', user_email;
  end if;

  update profiles set is_admin = true where id = target;
end;
$fn$;

-- Bootstrapping only: the very first admin has to be made by someone who is not
-- yet an admin, so this one is callable directly against the database (SQL
-- editor / service role) rather than from the app.
revoke execute on function make_admin(text) from authenticated, anon;

-- These three are bootstrap tools, callable only with the service role or from
-- the SQL editor. Revoking execute is what makes the relaxed uid check above
-- safe: no API caller can invoke them at all, whatever their uid.
revoke execute on function create_course(text, smallint[]) from authenticated, anon;
revoke execute on function build_round(text, uuid, int) from authenticated, anon;
