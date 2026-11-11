/*
  From the testers' ninth run.

  1. No line for a change that changes nothing. A hole saved again with the
     number it already had wrote "changed hole 2 from 5 to 5". An update
     that leaves the strokes as they were is no longer logged. (The phone
     sends a hole's net change now, so 5, then 6, then 5 again offline is
     no change, and nothing is written.)

  2. Clear's lines say why, in hole order. Each "removed" line a clear
     writes carries the reason "Cleared with “Clear all”", as a put-back's
     lines say theirs, and the holes are taken off player by player, hole
     by hole, so the log reads in that order rather than however the rows
     happened to lie.

  3. A round on a course with one tee counts toward the handicap. With no
     tee recorded for the round and no tee preference on the profile, the
     round had no rating, so no differential: six signed nine-hole rounds
     still read "3 more rounds to calculate". (Nine holes do count: each is
     made up to an 18-hole differential, as WHS does.) Where the course has
     only one tee, that is the tee played. With several and nothing to say
     which, the round still has no rating, and the profile says why.

  One new function (the course's only tee) and replaced ones. No score,
  player or league row is changed.
*/

-- ------------------------------------------------------------ no line for no change

-- As in 0059, with nothing logged for an update that leaves the strokes.
create or replace function log_score_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  phone_at timestamptz;
begin
  if TG_OP = 'UPDATE' and new.strokes is not distinct from old.strokes then
    return new;
  end if;

  if new.entered_on_phone_at is not null
     and (TG_OP = 'INSERT'
          or (TG_OP = 'UPDATE' and new.entered_on_phone_at is distinct from old.entered_on_phone_at)) then
    -- Never later than now: a phone's clock can be wrong.
    phone_at := least(new.entered_on_phone_at, now());
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), lower(TG_OP), 'score', coalesce(new.id, old.id)::text,
    case TG_OP
      when 'INSERT' then jsonb_build_object('round_id', new.round_id, 'player_id', new.player_id,
                                            'hole', new.hole, 'strokes', new.strokes)
      when 'UPDATE' then jsonb_build_object('round_id', new.round_id, 'player_id', new.player_id,
                                            'hole', new.hole, 'from', old.strokes, 'to', new.strokes)
      else jsonb_build_object('round_id', old.round_id, 'player_id', old.player_id,
                              'hole', old.hole, 'strokes', old.strokes)
    end
    || jsonb_strip_nulls(jsonb_build_object(
         'reason',  nullif(current_setting('pukagolf.change_reason', true), ''),
         'cardWas', nullif(current_setting('pukagolf.card_was', true), ''),
         'phoneAt', phone_at)));
  return coalesce(new, old);
end;
$fn$;

-- ------------------------------------------------------------ clearing, with its reason, in hole order

-- As in 0059, with the reason on each hole's line and the holes in order.
create or replace function owner_clear_round_scores(in_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed    integer := 0;
  reopened   integer;
  round_name text;
  league     uuid;
  batch_id   uuid := gen_random_uuid();
  to_live    boolean;
  one        record;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can clear a week.'
      using errcode = 'insufficient_privilege';
  end if;

  select name, league_id into round_name, league from rounds where id = in_round_id;

  if round_name is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  delete from cleared_scores where cleared_at < now() - interval '7 days';

  insert into cleared_scores (batch, round_id, player_id, hole, strokes, entered_by)
  select batch_id, round_id, player_id, hole, strokes, entered_by
    from scores where round_id = in_round_id;

  -- Read by log_score_change(): every "removed" line says why.
  perform set_config('pukagolf.change_reason', 'Cleared with “Clear all”', true);

  -- One at a time, so the log's lines go player by player, hole by hole.
  for one in
    select id from scores where round_id = in_round_id order by player_id, hole
  loop
    delete from scores where id = one.id;
    removed := removed + 1;
  end loop;

  perform set_config('pukagolf.change_reason', '', true);

  -- A signed card with nothing on it can't be scored or fixed: open it.
  delete from card_locks where round_id = in_round_id;
  get diagnostics reopened = row_count;

  to_live := not exists (select 1 from rounds r
                          where r.league_id is not distinct from league
                            and r.id <> in_round_id
                            and r.status = 'live');

  if to_live then
    update rounds set status = 'live' where id = in_round_id and status = 'final';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_scores', 'round', in_round_id::text,
          jsonb_build_object('name', round_name, 'removed', removed, 'batch', batch_id,
                             'round_id', in_round_id, 'cards_reopened', reopened,
                             'back_to_live', to_live));

  return removed;
end;
$fn$;

-- ------------------------------------------------------------ the tee played, on a one-tee course

-- The course's tee when it has only one, else null.
create or replace function only_tee(in_course_id uuid)
returns text
language sql
stable
set search_path = public
as $fn$
  select min(coalesce(ct.tee_color, ct.tee_key))
    from course_tees ct
   where ct.course_id = in_course_id
  having count(distinct lower(coalesce(ct.tee_color, ct.tee_key))) = 1;
$fn$;

revoke execute on function only_tee(uuid) from public, anon;
grant execute on function only_tee(uuid) to authenticated;

-- As in 0047, with a one-tee course's tee when nothing else says which.
create or replace function player_rounds(in_player_id uuid)
returns jsonb
language plpgsql
stable
security definer
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
                 'startHole', rd.start_hole,
                 -- The tee played, then whatever the player's preference
                 -- resolves to on this course, then the course's only tee,
                 -- then nothing.
                 'tee', t.tee,
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
          cross join lateral (
            select coalesce(ttp.played_tee,
                            resolve_tee_preference(rd.course_id, pr.preferred_tee),
                            only_tee(rd.course_id)) as tee
          ) t
          left join lateral (
            -- The rated set matching the tee played, longest when a course
            -- rates the same colour more than once.
            select ct2.course_rating, ct2.slope
              from course_tees ct2
             where ct2.course_id = rd.course_id
               and lower(coalesce(ct2.tee_color, ct2.tee_key)) = lower(coalesce(t.tee, ''))
             order by ct2.yardage desc nulls last
             limit 1
          ) ct on true
         where exists (
           select 1 from scores s
            where s.round_id = rd.id and s.player_id = in_player_id
         )
           and sees_score_of(in_player_id, rd.league_id)
      ) as r
  ), '[]'::jsonb);
end;
$fn$;
