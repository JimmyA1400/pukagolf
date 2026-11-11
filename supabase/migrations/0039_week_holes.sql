/*
  Changing a week's holes after it has started.

  A week is set up for 18 and the groups play nine — darkness, weather, or
  because that is what the league does that night. Until now the only way to
  say so was to start the week over, because the holes could be chosen when a
  week was created and never again.

  It matters for more than the look of the card: a round is complete when a
  player has posted hole_count holes, so nine cards against an 18-hole week
  are all unfinished, nobody places, and the week hands out no points at all.

  Nothing is deleted. Changing the holes is refused outright if any score sits
  outside the new range, so a wrong setting can't quietly orphan a card, and
  setting it back puts the week exactly as it was.
*/

create or replace function admin_set_week_holes(
  in_round_id   uuid,
  in_hole_count integer,
  in_start_hole integer default 1
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  week       rounds%rowtype;
  course_max integer;
  last       integer;
  stray      text;
begin
  if not is_admin() then
    raise exception 'Only an admin can change the week''s holes.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if in_hole_count is null or in_hole_count not in (9, 18) then
    raise exception 'A week is 9 or 18 holes.' using errcode = 'check_violation';
  end if;

  if in_start_hole is null or in_start_hole not in (1, 10) then
    raise exception 'A week starts on hole 1 or hole 10.' using errcode = 'check_violation';
  end if;

  if in_start_hole = 10 and in_hole_count <> 9 then
    raise exception 'Only a nine can be played on the back.' using errcode = 'check_violation';
  end if;

  last := in_start_hole + in_hole_count - 1;

  select hole_count into course_max from courses where id = week.course_id;

  if last > coalesce(course_max, 18) then
    raise exception 'That course only has % holes.', course_max
      using errcode = 'check_violation';
  end if;

  -- A score outside the new range would belong to no hole of the week. Say
  -- whose it is rather than dropping it or leaving it stranded.
  select string_agg(distinct p.full_name, ', ' order by p.full_name)
    into stray
    from scores s
    join profiles p on p.id = s.player_id
   where s.round_id = in_round_id
     and (s.hole < in_start_hole or s.hole > last);

  if stray is not null then
    raise exception
      'Holes % to % would leave scores behind: % already posted outside them. Clear those holes first.',
      in_start_hole, last, stray
      using errcode = 'check_violation';
  end if;

  update rounds
     set hole_count = in_hole_count,
         start_hole = in_start_hole
   where id = in_round_id;

  -- The groups tee off on the week's first hole.
  update tee_times set starting_hole = in_start_hole where round_id = in_round_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('hole_count', in_hole_count, 'start_hole', in_start_hole,
                             'was_hole_count', week.hole_count,
                             'was_start_hole', week.start_hole));
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function admin_set_week_holes(uuid, integer, integer) from public, anon;
grant execute on function admin_set_week_holes(uuid, integer, integer) to authenticated;
