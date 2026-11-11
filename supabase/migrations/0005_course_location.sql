-- Where a course actually is, so conditions can be fetched rather than typed.
--
-- Weather comes from Open-Meteo, which needs no API key. The admin searches for
-- a place, picks it, and the coordinates are stored here. Rounds inherit the
-- location from their course.

alter table courses
  add column latitude      double precision,
  add column longitude     double precision,
  add column timezone      text,
  -- What the admin searched for, e.g. "Pinehurst, North Carolina". Kept so the
  -- UI can show where conditions are being read from without reverse geocoding.
  add column location_name text;

alter table courses
  add constraint latitude_in_range
    check (latitude is null or latitude between -90 and 90),
  add constraint longitude_in_range
    check (longitude is null or longitude between -180 and 180),
  -- Coordinates are meaningless individually; require both or neither.
  add constraint location_is_complete
    check ((latitude is null) = (longitude is null));

-- round_settings.temp_f / wind / sunset stay as the fallback for a course with
-- no location set. `greens` remains admin-entered whatever happens: how the
-- greens are running is a judgement no forecast can make.
comment on column round_settings.greens is
  'Admin-entered. Not available from any weather source.';
