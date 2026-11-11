-- Real course data imported from OpenGolfAPI.
--
-- Replaces hand-entered pars and a hand-searched location: one import brings
-- coordinates (for weather), par and stroke index per hole, yardages per tee,
-- and the course rating and slope each tee plays to.
--
-- Source is ODbL-licensed, so `attribution` travels with the course and must be
-- displayed wherever the data is.

alter table courses
  -- The upstream course id, so a re-import updates rather than duplicates.
  add column external_id text unique,
  add column city        text,
  add column state       text,
  add column attribution text;

-- Courses are not all 9 or 18 holes, and an import should store what a course
-- actually has rather than be rejected for it. The original check refused
-- anything else, which failed on a real course with partial hole data.
alter table courses drop constraint if exists courses_hole_count_check;
alter table courses add  constraint courses_hole_count_check
  check (hole_count between 1 and 36);

alter table rounds  drop constraint if exists rounds_hole_count_check;
alter table rounds  add  constraint rounds_hole_count_check
  check (hole_count between 1 and 36);

alter table course_holes
  -- Stroke index: 1 is the hardest hole, 18 the easiest. This is what decides
  -- which holes a player receives a shot on once handicaps exist.
  add column handicap_index smallint
    check (handicap_index is null or handicap_index between 1 and 18),
  -- Yardage per tee colour, e.g. {"blue": 371, "white": 345}. Tee names vary by
  -- course, so a fixed set of columns would not survive contact with reality.
  add column yardages jsonb;

-- The tee sets a course offers. Course rating and slope belong to the tee, not
-- the course: the same eighteen holes play very differently from the tips.
create table course_tees (
  course_id     uuid not null references courses on delete cascade,
  tee_key       text not null,
  tee_name      text not null,
  tee_color     text,
  gender        text,
  course_rating numeric(4, 1),
  slope         smallint check (slope is null or slope between 55 and 155),
  par           smallint,
  yardage       integer,
  primary key (course_id, tee_key)
);

alter table course_tees enable row level security;

create policy read_tees on course_tees for select to authenticated using (true);
create policy admin_tees on course_tees for all to authenticated
  using (is_admin()) with check (is_admin());

-- Importing writes courses, course_holes and course_tees together. Doing it in
-- one function keeps a half-imported course from ever existing.
create or replace function import_course(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- All three are suffixed to avoid colliding with COLUMNS of the same name in
  -- the inserts below (course_id, hole, tee). A bare `hole` inside the
  -- course_holes insert is ambiguous and Postgres refuses the whole statement.
  imported_id uuid;
  hole_json   jsonb;
  tee_json    jsonb;
begin
  -- Null uid means the service role or SQL editor, not a player; execute is
  -- revoked from anon below.
  if auth.uid() is not null and not is_admin() then
    raise exception 'Only an admin can import a course.';
  end if;

  insert into courses (
    name, hole_count, external_id, latitude, longitude, timezone,
    location_name, city, state, attribution
  )
  values (
    payload ->> 'name',
    (payload ->> 'hole_count')::smallint,
    payload ->> 'external_id',
    (payload ->> 'latitude')::double precision,
    (payload ->> 'longitude')::double precision,
    payload ->> 'timezone',
    payload ->> 'location_name',
    payload ->> 'city',
    payload ->> 'state',
    payload ->> 'attribution'
  )
  on conflict (external_id) do update set
    name          = excluded.name,
    hole_count    = excluded.hole_count,
    latitude      = excluded.latitude,
    longitude     = excluded.longitude,
    timezone      = excluded.timezone,
    location_name = excluded.location_name,
    city          = excluded.city,
    state         = excluded.state,
    attribution   = excluded.attribution
  returning id into imported_id;

  for hole_json in select * from jsonb_array_elements(payload -> 'holes') loop
    insert into course_holes (course_id, hole, par, handicap_index, yardages)
    values (
      imported_id,
      (hole_json ->> 'hole')::smallint,
      (hole_json ->> 'par')::smallint,
      (hole_json ->> 'handicap_index')::smallint,
      hole_json -> 'yardages'
    )
    on conflict (course_id, hole) do update set
      par            = excluded.par,
      handicap_index = excluded.handicap_index,
      yardages       = excluded.yardages;
  end loop;

  -- Tee sets are replaced wholesale: a course that drops a tee should lose it.
  delete from course_tees where course_tees.course_id = imported_id;

  for tee_json in select * from jsonb_array_elements(payload -> 'tees') loop
    insert into course_tees (
      course_id, tee_key, tee_name, tee_color, gender,
      course_rating, slope, par, yardage
    )
    values (
      imported_id,
      tee_json ->> 'tee_key',
      tee_json ->> 'tee_name',
      tee_json ->> 'tee_color',
      tee_json ->> 'gender',
      (tee_json ->> 'course_rating')::numeric,
      (tee_json ->> 'slope')::smallint,
      (tee_json ->> 'par')::smallint,
      (tee_json ->> 'yardage')::integer
    );
  end loop;

  return imported_id;
end;
$fn$;

revoke execute on function import_course(jsonb) from anon;
