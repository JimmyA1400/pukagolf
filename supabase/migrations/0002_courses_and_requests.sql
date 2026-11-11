-- Courses (par per hole), self-signup, and player tee time requests.
--
-- Par exists here for one reason: showing a player as +2 / E / -1 while they
-- are still on the course. That is score-to-par, and it cannot be derived from
-- stroke totals alone. Entered once per course and reused by every round played
-- there, so it is not per-round admin work.

-- ----------------------------------------------------------------- courses

create table courses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  hole_count smallint not null default 18 check (hole_count in (9, 18)),
  created_at timestamptz not null default now()
);

create table course_holes (
  course_id uuid not null references courses on delete cascade,
  hole      smallint not null check (hole >= 1),
  par       smallint not null check (par between 3 and 6),
  primary key (course_id, hole)
);

alter table rounds add column course_id uuid references courses;

-- Prefills a standard par-72 layout so adding a course is confirming numbers
-- rather than typing eighteen of them. Front nine mirrors the back.
create or replace function seed_standard_pars(target_course uuid)
returns void
language plpgsql
as $fn$
declare
  standard smallint[] := array[4,4,3,5,4,3,4,5,4, 4,4,3,5,4,3,4,5,4];
  holes    smallint;
begin
  select hole_count into holes from courses where id = target_course;

  insert into course_holes (course_id, hole, par)
  select target_course, i, standard[i]
    from generate_series(1, holes) as i
  on conflict (course_id, hole) do nothing;
end;
$fn$;

-- ------------------------------------------------------------ self-signup

-- Players create their own accounts; a profile row follows automatically.
-- is_admin stays false — the first admin is promoted by hand.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), new.email)
  )
  on conflict (id) do nothing;

  return new;
end;
$fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ------------------------------------------------------- tee time requests

-- Players ask; the admin still decides. Nothing here writes to tee_times — it
-- is input to scheduling, not a booking.
create table tee_time_requests (
  id                uuid primary key default gen_random_uuid(),
  round_id          uuid not null references rounds on delete cascade,
  player_id         uuid not null references profiles on delete cascade,
  -- Preferred window, either end optional: "after 9am", "before noon", both.
  earliest          time,
  latest            time,
  -- Players this player would like to be grouped with. Advisory only; the
  -- admin builds the actual pairings.
  preferred_partners uuid[] not null default '{}',
  notes             text,
  status            text not null default 'pending'
                    check (status in ('pending', 'scheduled', 'declined')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (round_id, player_id),
  constraint window_ordered check (
    earliest is null or latest is null or earliest <= latest
  )
);

create trigger tee_time_requests_touch
  before update on tee_time_requests
  for each row execute function touch_updated_at();

-- -------------------------------------------------------------------- RLS

alter table courses           enable row level security;
alter table course_holes      enable row level security;
alter table tee_time_requests enable row level security;

create policy read_courses on courses for select to authenticated using (true);
create policy admin_courses on courses for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_course_holes on course_holes for select to authenticated using (true);
create policy admin_course_holes on course_holes for all to authenticated
  using (is_admin()) with check (is_admin());

-- A player manages their own request and sees nobody else's; the admin sees
-- every request in order to schedule against them.
create policy read_own_request on tee_time_requests for select to authenticated
  using (player_id = auth.uid() or is_admin());

create policy write_own_request on tee_time_requests for insert to authenticated
  with check (player_id = auth.uid() and status = 'pending');

create policy update_own_request on tee_time_requests for update to authenticated
  using (player_id = auth.uid())
  -- A player may revise their preferences but not mark themselves scheduled.
  with check (player_id = auth.uid() and status = 'pending');

create policy delete_own_request on tee_time_requests for delete to authenticated
  using (player_id = auth.uid() or is_admin());

create policy admin_requests on tee_time_requests for all to authenticated
  using (is_admin()) with check (is_admin());

-- --------------------------------------------------------------- realtime

alter publication supabase_realtime add table tee_time_requests;
