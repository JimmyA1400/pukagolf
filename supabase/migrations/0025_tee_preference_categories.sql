/*
  A tee preference is one of five categories, not a tee name.

  Courses name their tees whatever they like — colours at one club, Roman
  numerals at the next — so the old free-text preference matched exactly one
  course and was dead weight everywhere else. The five categories are resolved
  against each course's own card instead, by `resolve_tee_preference` here and
  by `resolveTee` in src/lib/tee-preference.ts. The two have to agree, so both
  use the same rule: a set the card names outright wins, otherwise the five
  ranks are spread across however many sets the course carries.
*/

-- Keep what the old value plainly meant; drop the rest to "no preference",
-- which is what an unmatched name already behaved as.
update profiles
   set preferred_tee = case
     when preferred_tee ~* '(female|ladies|lady|women)' then 'ladies'
     when preferred_tee ~* '(senior|elder)'             then 'elderly'
     when preferred_tee ~* '(championship|tips|tiger)'  then 'tips'
     when preferred_tee ~* '(forward|front|junior|family)' then 'front'
     when preferred_tee in ('tips', 'mens', 'elderly', 'ladies', 'front')
       then preferred_tee
     else null
   end
 where preferred_tee is not null;

alter table profiles
  add constraint profiles_preferred_tee_check
  check (preferred_tee is null
         or preferred_tee in ('tips', 'mens', 'elderly', 'ladies', 'front'));

/*
  The tee on a course that answers a preference.

  Rank 0 is the longest set and rank 4 the shortest, so Tips always lands on
  the back tees and Front Tees always on the shortest, whether the course
  carries two sets or seven.
*/
create or replace function resolve_tee_preference(
  in_course_id  uuid,
  in_preference text
)
returns text
language sql
stable
set search_path = public
as $fn$
  with sets as (
    -- One row per physical tee. A course that rates the same tee for men and
    -- for women has two rows for it, same yardage, different slope; counting
    -- both would hand Mens the women's rating of the back tee.
    select coalesce(ct.tee_color, ct.tee_key) as tee,
           max(coalesce(ct.yardage, 0))       as yards
      from course_tees ct
     where ct.course_id = in_course_id
     group by 1
  ),
  ranked as (
    select tee, yards,
           -- Words first: "Iv-v-female" has to read as words before a keyword
           -- can match it, exactly as the client does.
           regexp_replace(lower(tee), '[^a-z]+', ' ', 'g') as words,
           row_number() over (order by yards desc, tee) - 1 as rank,
           count(*) over ()                                as n
      from sets
  ),
  named as (
    select tee
      from ranked
     where case in_preference
             when 'tips'    then words ~ '(^| )(championship|tips|tiger)( |$)'
             when 'elderly' then words ~ '(^| )(senior|seniors|elder|elderly)( |$)'
             when 'ladies'  then words ~ '(^| )(female|ladies|lady|women|womens)( |$)'
             when 'front'   then words ~ '(^| )(forward|front|junior|family)( |$)'
             else false
           end
     order by yards desc, tee
     limit 1
  )
  select coalesce(
    (select tee from named),
    (select tee from ranked
      where rank = round(
        (case in_preference
           when 'tips' then 0 when 'mens' then 1 when 'elderly' then 2
           when 'ladies' then 3 when 'front' then 4
         end)::numeric * (n - 1) / 4
      ))
  )
   where in_preference in ('tips', 'mens', 'elderly', 'ladies', 'front');
$fn$;

revoke execute on function resolve_tee_preference(uuid, text) from public;
revoke execute on function resolve_tee_preference(uuid, text) from anon;
grant execute on function resolve_tee_preference(uuid, text) to authenticated;

/*
  Reject anything that is not one of the five, rather than storing a name the
  scorecard will never match.
*/
create or replace function save_player_details(
  in_full_name          text,
  in_phone              text,
  in_handicap_index     numeric,
  in_preferred_tee_time time,
  in_preferred_tee      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me  uuid := auth.uid();
  tee text := nullif(btrim(lower(coalesce(in_preferred_tee, ''))), '');
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_full_name, ''))) < 2 then
    raise exception 'Enter your first and last name.'
      using errcode = 'check_violation';
  end if;

  if in_phone is not null and in_phone !~ '^\+1[2-9]\d{2}[2-9]\d{6}$' then
    raise exception 'That phone number is not a valid US number.'
      using errcode = 'check_violation';
  end if;

  if in_handicap_index is not null
     and (in_handicap_index < -10 or in_handicap_index > 54) then
    raise exception 'A handicap index runs from +10 to 54.'
      using errcode = 'check_violation';
  end if;

  if tee is not null
     and tee not in ('tips', 'mens', 'elderly', 'ladies', 'front') then
    raise exception 'Pick one of the five tee sets.'
      using errcode = 'check_violation';
  end if;

  update profiles
     set full_name          = btrim(in_full_name),
         phone              = in_phone,
         handicap_index     = in_handicap_index,
         preferred_tee_time = in_preferred_tee_time,
         preferred_tee      = tee
   where id = me;

  return (select to_jsonb(p) - 'is_admin' from profiles p where p.id = me);
end;
$fn$;

revoke execute on function save_player_details(text, text, numeric, time, text)
  from public;
revoke execute on function save_player_details(text, text, numeric, time, text)
  from anon;
grant execute on function save_player_details(text, text, numeric, time, text)
  to authenticated;

/*
  player_rounds falls back to the preference when no tee was recorded for the
  round, so it has to resolve the category too — otherwise every pre-existing
  round loses its rating and slope, and with them its differential.
*/
create or replace function player_rounds(in_player_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(r order by r.played_on desc)
      from (
        select jsonb_build_object(
                 'roundId',   rd.id,
                 'name',      rd.name,
                 'playedOn',  rd.played_on,
                 'status',    rd.status,
                 'courseName', co.name,
                 'holeCount', rd.hole_count,
                 -- The tee played, then whatever the player's preference
                 -- resolves to on this course, then nothing.
                 'tee', coalesce(
                          ttp.played_tee,
                          resolve_tee_preference(rd.course_id, pr.preferred_tee)
                        ),
                 'courseRating', ct.course_rating,
                 'slope', ct.slope,
                 'coursePar', (
                   select sum(ch.par) from course_holes ch
                    where ch.course_id = rd.course_id
                 ),
                 'scores', coalesce((
                   select jsonb_object_agg(s.hole::text, s.strokes)
                     from scores s
                    where s.round_id = rd.id and s.player_id = in_player_id
                 ), '{}'::jsonb),
                 'pars', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.par)
                     from course_holes ch where ch.course_id = rd.course_id
                 ), '{}'::jsonb),
                 'strokeIndexes', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.handicap_index)
                     from course_holes ch
                    where ch.course_id = rd.course_id
                      and ch.handicap_index is not null
                 ), '{}'::jsonb)
               ) as r,
               rd.played_on
          from rounds rd
          join tee_time_players ttp
            on ttp.round_id = rd.id and ttp.player_id = in_player_id
          join profiles pr on pr.id = in_player_id
          left join courses co on co.id = rd.course_id
          left join lateral (
            -- The rated set matching the tee played, longest when a course
            -- rates the same colour more than once.
            select ct2.course_rating, ct2.slope
              from course_tees ct2
             where ct2.course_id = rd.course_id
               and lower(coalesce(ct2.tee_color, ct2.tee_key))
                   = lower(coalesce(
                       ttp.played_tee,
                       resolve_tee_preference(rd.course_id, pr.preferred_tee),
                       ''
                     ))
             order by ct2.yardage desc nulls last
             limit 1
          ) ct on true
         where exists (
           select 1 from scores s
            where s.round_id = rd.id and s.player_id = in_player_id
         )
      ) as r
  ), '[]'::jsonb);
end;
$fn$;

revoke execute on function player_rounds(uuid) from public;
revoke execute on function player_rounds(uuid) from anon;
grant execute on function player_rounds(uuid) to authenticated;
