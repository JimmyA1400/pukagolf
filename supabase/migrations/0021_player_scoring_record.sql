-- A player's scoring record, and the tee each round was played from.
--
-- The differential needs the rating and slope of the tee actually played, so
-- that has to be recorded rather than assumed. Rounds played before this
-- existed fall back to the player's preferred tee, and then to the course's
-- longest — stated plainly so a differential computed from a guess is at least
-- a documented guess.

alter table tee_time_players
  add column played_tee text;

/*
  Everything the profile needs about one player's rounds.

  Returned whole rather than as separate queries: the scorecard shown when a
  round is tapped uses the same rows as the list above it, and fetching them
  twice would let the two disagree.
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
                 -- The tee played, then the player's preference, then nothing.
                 'tee', coalesce(ttp.played_tee, pr.preferred_tee),
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
                   = lower(coalesce(ttp.played_tee, pr.preferred_tee, ''))
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
grant execute on function player_rounds(uuid) to authenticated;
