-- SECURITY FIX: seal internal functions from anonymous callers.
--
-- THE BUG
-- Postgres grants EXECUTE on a new function to PUBLIC by default. `anon` and
-- `authenticated` inherit that grant through PUBLIC, so the earlier
--
--   revoke execute on function make_admin(text) from authenticated, anon;
--
-- removed a grant those roles never held directly and left the PUBLIC grant
-- untouched. Every function I believed was sealed was in fact callable by
-- anyone holding the publishable key, which ships in every browser.
--
-- THE IMPACT
-- make_admin was the serious one: an anonymous caller could sign up and then
-- promote their own account to league admin, which is full control of scores,
-- rounds and events. import_course, create_course and build_round compounded
-- it, because their guards were deliberately relaxed to
--
--   if auth.uid() is not null and not is_admin() then raise ...
--
-- so that the SQL editor (which has no JWT, and therefore a null uid) could run
-- them during bootstrap. An anonymous PostgREST caller also has a null uid, so
-- that guard waved them straight through.
--
-- THE FIX
-- Revoke from PUBLIC, which is where the grant actually lived, and tighten the
-- relaxed guards so they no longer depend on the revoke being correct. Two
-- independent barriers, so neither one failing is enough on its own.

revoke execute on function make_admin(text)                    from public;
revoke execute on function create_course(text, smallint[])     from public;
revoke execute on function build_round(text, uuid, int)        from public;
revoke execute on function import_course(jsonb)                from public;
revoke execute on function create_event(jsonb)                 from public;
revoke execute on function event_id_for_token(text)            from public;
revoke execute on function event_for_admin_token(text)         from public;
revoke execute on function generate_event_pin()                from public;

-- Guarded: this helper exists only in databases where 0002 was applied in full.
-- A missing function would abort the whole transaction and leave the revokes
-- above unapplied, which is exactly how the first attempt at this fix failed.
do $$
begin
  if to_regprocedure('public.seed_standard_pars(uuid)') is not null then
    execute 'revoke execute on function seed_standard_pars(uuid) from public';
  end if;
end;
$$;

-- create_event is the one of these the app genuinely calls from the browser,
-- as a signed-in admin. It keeps a hard is_admin() check of its own.
grant execute on function create_event(jsonb) to authenticated;

-- Defence in depth: require a real signed-in admin, not merely "no JWT".
-- Bootstrap now runs these as the table owner in the SQL editor, which bypasses
-- the check entirely rather than relying on a null uid slipping past it.
create or replace function import_course(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  imported_id uuid;
  hole_json   jsonb;
  tee_json    jsonb;
begin
  -- session_user is the role the connection authenticated as. In the SQL
  -- editor that is the table owner; through PostgREST it is anon or
  -- authenticated, which must then prove admin.
  if session_user not in ('postgres', 'supabase_admin') and not is_admin() then
    raise exception 'Only an admin can import a course.'
      using errcode = 'insufficient_privilege';
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

revoke execute on function import_course(jsonb) from public;
grant execute on function import_course(jsonb) to authenticated;
