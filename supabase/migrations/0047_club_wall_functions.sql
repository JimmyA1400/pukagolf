/*
  The wall between clubs, for every function.

  The last migration fenced the tables. Most of the app doesn't touch them
  directly: it calls functions that run as security definer, which pass
  straight through row level security. So each of those does its own check,
  and until now every check was "is this person an admin?" with no question
  of which club. Here each one asks about the club the thing belongs to:

    a week, a group, a score     the club its league is in
    an event                     its club
    a player                     a club the caller runs that the player is in
    a tournament, a charity      its club

  and the functions that read for a player (a season, an event, someone's
  round history) return only what that player may see.

  Untouched, because they are already confined: may_score() and the scoring
  rotation, which follow scorer_assignments and so work identically in every
  club; and the outing functions that take a share link or an admin token,
  where holding the link is the permission.

  Still "PukaGolf's": the functions for the one set of league rules, the
  announcement, the tee-time defaults and closing a season. They are gated by
  is_admin()/is_owner(), which now mean "admin of PukaGolf", and they act on
  the Saturday League only. They gain a league to act on when the admin pages
  do.

  Each function below is its live definition with only the lines described
  above it changed. Replacing a function keeps who may call it.
*/

-- admin_add_group: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.admin_add_group(in_round_id uuid, in_tee_at timestamp with time zone, in_seats integer DEFAULT 4)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  tee uuid;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from rounds where id = in_round_id) then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if in_tee_at is null then
    raise exception 'Give the group a tee time.' using errcode = 'check_violation';
  end if;

  if in_seats is null or in_seats not between 2 and 4 then
    raise exception 'A tee time holds two, three or four.' using errcode = 'check_violation';
  end if;

  insert into tee_times (round_id, tee_at, starting_hole, seats)
  values (in_round_id, in_tee_at, 1, in_seats)
  returning id into tee;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'group', tee::text,
          jsonb_build_object('round_id', in_round_id, 'tee_at', in_tee_at,
                             'seats', in_seats));

  return tee;
end;
$function$;

-- admin_build_week_from_rsvps: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.admin_build_week_from_rsvps(in_round_id uuid, in_first_tee timestamp with time zone, in_interval_minutes integer DEFAULT 10, in_group_size integer DEFAULT 4)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  week        rounds%rowtype;
  ids         uuid[];
  total       integer;
  group_count integer;
  base        integer;
  extra       integer;
  seats       integer;
  taken       integer := 0;
  tee         uuid;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can build groups.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if exists (select 1 from scores where round_id = in_round_id) then
    raise exception 'This week already has scores, so its groups can''t be rebuilt. Move players one at a time instead.'
      using errcode = 'check_violation';
  end if;

  if in_first_tee is null then
    raise exception 'Pick the first tee time.' using errcode = 'check_violation';
  end if;

  if in_group_size not between 2 and 4 then
    raise exception 'Groups hold 2 to 4 players.' using errcode = 'check_violation';
  end if;

  if in_interval_minutes not between 5 and 30 then
    raise exception 'Tee times go 5 to 30 minutes apart.'
      using errcode = 'check_violation';
  end if;

  select array_agg(p.id order by p.preferred_tee_time nulls last, p.full_name)
    into ids
    from round_rsvps r
    join profiles p on p.id = r.player_id
   where r.round_id = in_round_id
     and r.status = 'in';

  total := coalesce(array_length(ids, 1), 0);

  if total < 2 then
    raise exception 'Only % said they''re in, and a group needs at least 2.',
      case total when 1 then 'one player' else 'nobody' end
      using errcode = 'check_violation';
  end if;

  group_count := ceil(total::numeric / in_group_size);

  while group_count > 1 and total / group_count < 2 loop
    group_count := group_count - 1;
  end loop;

  base  := total / group_count;
  extra := total % group_count;

  -- Cascades to the old groups' players and scoring rings.
  delete from tee_times where round_id = in_round_id;

  for g in 0 .. group_count - 1 loop
    seats := base + case when g < extra then 1 else 0 end;

    insert into tee_times (round_id, tee_at, starting_hole, seats)
    values (in_round_id,
            in_first_tee + make_interval(mins => g * in_interval_minutes),
            coalesce(week.start_hole, 1),
            seats)
    returning id into tee;

    for i in 1 .. seats loop
      insert into tee_time_players (tee_time_id, round_id, player_id, position)
      values (tee, in_round_id, ids[taken + i], i - 1);
    end loop;

    taken := taken + seats;
    perform rebuild_scoring_ring(tee);
  end loop;

  -- Pairings are made: lock RSVPs, and open the week for scoring.
  update rounds
     set rsvp_lock_at = coalesce(rsvp_lock_at, now()),
         status = case when status = 'setup' then 'live' else status end
   where id = in_round_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'build_groups', 'round', in_round_id::text,
          jsonb_build_object('groups', group_count, 'players', total,
                             'first_tee', in_first_tee, 'seats', in_group_size));

  return jsonb_build_object('groups', group_count, 'players', total);
end;
$function$;

-- admin_retime_groups: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.admin_retime_groups(in_round_id uuid, in_first_tee timestamp with time zone, in_interval_minutes integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  moved integer;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can change tee times.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from rounds where id = in_round_id) then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if in_first_tee is null then
    raise exception 'Pick the first tee time.' using errcode = 'check_violation';
  end if;

  if in_interval_minutes is null or in_interval_minutes not between 5 and 30 then
    raise exception 'Tee times go 5 to 30 minutes apart.'
      using errcode = 'check_violation';
  end if;

  -- row_number() is a bigint, and make_interval takes an integer.
  update tee_times t
     set tee_at = in_first_tee + make_interval(mins => ((o.n - 1) * in_interval_minutes)::integer)
    from (
      select id, row_number() over (order by tee_at, id) as n
        from tee_times where round_id = in_round_id
    ) as o
   where t.id = o.id;

  get diagnostics moved = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'retime_groups', 'round', in_round_id::text,
          jsonb_build_object('first_tee', in_first_tee, 'interval', in_interval_minutes,
                             'groups', moved));

  return moved;
end;
$function$;

-- admin_set_week_game: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.admin_set_week_game(in_round_id uuid, in_game text, in_points integer[] DEFAULT NULL::integer[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  table_used integer[];
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can change the week''s game.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_game is null or in_game not in ('stroke', 'stableford', 'scramble', 'best_ball') then
    raise exception 'Pick stroke play, Stableford, best ball or a scramble.'
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from rounds where id = in_round_id) then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if in_game = 'stableford' then
    table_used := coalesce(
      in_points,
      (select stableford_points::integer[] from league_settings),
      '{5,4,3,2,1,0}'
    );
    perform check_stableford_table(table_used);
  end if;

  update rounds
     set game = in_game,
         stableford_points = table_used::smallint[]
   where id = in_round_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('game', in_game, 'stableford_points', table_used));
end;
$function$;

-- admin_set_week_holes: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.admin_set_week_holes(in_round_id uuid, in_hole_count integer, in_start_hole integer DEFAULT 1)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  week       rounds%rowtype;
  course_max integer;
  last       integer;
  stray      text;
begin
  if not is_club_admin(round_club(in_round_id)) then
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
$function$;

-- admin_set_week_simulator: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.admin_set_week_simulator(in_round_id uuid, in_value boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can change the week.'
      using errcode = 'insufficient_privilege';
  end if;

  update rounds set is_simulator = coalesce(in_value, false) where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('is_simulator', coalesce(in_value, false)));
end;
$function$;

-- admin_week_groups: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.admin_week_groups(in_round_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  week rounds%rowtype;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'round', jsonb_build_object(
      'id',         week.id,
      'name',       week.name,
      'playedOn',   week.played_on,
      'status',     week.status,
      'rsvpLockAt', week.rsvp_lock_at,
      'game',       week.game,
      'hasScores',  exists (select 1 from scores where round_id = week.id)
    ),

    'groups', coalesce((
      select jsonb_agg(g.entry order by g.tee_at, g.id)
        from (
          select t.tee_at,
                 t.id,
                 jsonb_build_object(
                   'id',     t.id,
                   'teeAt',  t.tee_at,
                   'seats',  t.seats,
                   'players', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',       ttp.player_id,
                                'name',     p.full_name,
                                'position', ttp.position,
                                'isGuest',  p.is_guest,
                                -- Who keeps this player's card, so the ring is visible.
                                'keptBy',   (
                                  select k.full_name
                                    from scorer_assignments sa
                                    join profiles k on k.id = sa.scorer_player_id
                                   where sa.tee_time_id = t.id
                                     and sa.scored_player_id = ttp.player_id
                                )
                              ) order by ttp.position
                            )
                       from tee_time_players ttp
                       join profiles p on p.id = ttp.player_id
                      where ttp.tee_time_id = t.id
                   ), '[]'::jsonb)
                 ) as entry
            from tee_times t
           where t.round_id = week.id
        ) as g
    ), '[]'::jsonb),

    -- Everyone not in a group this week, with their answer; guests last.
    'others', coalesce((
      select jsonb_agg(o.entry order by o.rank, o.name)
        from (
          select p.full_name as name,
                 case when p.is_guest then 4
                      else case r.status when 'in' then 0 when 'undecided' then 2
                                         when 'out' then 3 else 1 end
                 end as rank,
                 jsonb_build_object(
                   'id',               p.id,
                   'name',             p.full_name,
                   'rsvp',             r.status,
                   'preferredTeeTime', p.preferred_tee_time,
                   'isGuest',          p.is_guest
                 ) as entry
            from profiles p
            left join round_rsvps r on r.round_id = week.id and r.player_id = p.id
           where not exists (
             select 1 from tee_time_players ttp
              where ttp.round_id = week.id and ttp.player_id = p.id
           )
        ) as o
    ), '[]'::jsonb),

    'rsvp', jsonb_build_object(
      'in',        (select count(*) from round_rsvps where round_id = week.id and status = 'in'),
      'out',       (select count(*) from round_rsvps where round_id = week.id and status = 'out'),
      'undecided', (select count(*) from round_rsvps where round_id = week.id and status = 'undecided'),
      'noAnswer',  (select count(*) from profiles p
                     where not p.is_guest
                       and not exists (select 1 from round_rsvps r
                                        where r.round_id = week.id and r.player_id = p.id))
    )
  );
end;
$function$;

-- complete_round: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.complete_round(in_round_id uuid, force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare holes smallint; short text;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can complete a round.' using errcode = 'insufficient_privilege';
  end if;

  select hole_count into holes from rounds where id = in_round_id;
  if holes is null then
    raise exception 'No such round.' using errcode = 'no_data_found';
  end if;

  if not force then
    select string_agg(pr.full_name || ' (' || posted.n || ' of ' || holes || ')', ', ')
      into short
      from tee_time_players ttp
      join profiles pr on pr.id = ttp.player_id
      join lateral (select count(*) as n from scores s
                     where s.round_id = in_round_id and s.player_id = ttp.player_id) posted on true
     where ttp.round_id = in_round_id and posted.n < holes;

    if short is not null then
      raise exception 'Still missing holes: %.', short using errcode = 'check_violation';
    end if;
  end if;

  update rounds set status = 'final' where id = in_round_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('status','final','forced',force));

  return jsonb_build_object('round_id', in_round_id, 'status', 'final');
end;
$function$;

-- owner_clear_round_feed: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.owner_clear_round_feed(in_round_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  removed    integer;
  round_name text;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can clear the clubhouse feed.'
      using errcode = 'insufficient_privilege';
  end if;

  select name into round_name from rounds where id = in_round_id;

  if round_name is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  delete from feed_posts where round_id = in_round_id;
  get diagnostics removed = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_feed', 'round', in_round_id::text,
          jsonb_build_object('name', round_name, 'removed', removed));

  return removed;
end;
$function$;

-- owner_clear_round_scores: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.owner_clear_round_scores(in_round_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  removed    integer;
  round_name text;
  batch_id   uuid := gen_random_uuid();
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can clear a week.'
      using errcode = 'insufficient_privilege';
  end if;

  select name into round_name from rounds where id = in_round_id;

  if round_name is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  delete from cleared_scores where cleared_at < now() - interval '7 days';

  insert into cleared_scores (batch, round_id, player_id, hole, strokes, entered_by)
  select batch_id, round_id, player_id, hole, strokes, entered_by
    from scores where round_id = in_round_id;

  delete from scores where round_id = in_round_id;
  get diagnostics removed = row_count;

  update rounds set status = 'live' where id = in_round_id and status = 'final';

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear_scores', 'round', in_round_id::text,
          jsonb_build_object('name', round_name, 'removed', removed, 'batch', batch_id));

  return removed;
end;
$function$;

-- owner_restore_scores: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.owner_restore_scores(in_round_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  batch_id uuid;
  restored integer;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can restore scores.'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from scores where round_id = in_round_id) then
    raise exception 'This week has new scores since it was cleared, so the old ones can''t come back.'
      using errcode = 'check_violation';
  end if;

  select batch into batch_id
    from cleared_scores
   where round_id = in_round_id and cleared_at >= now() - interval '7 days'
   order by cleared_at desc
   limit 1;

  if batch_id is null then
    raise exception 'There''s nothing cleared from this week to put back.'
      using errcode = 'no_data_found';
  end if;

  -- Hole order, so the sequential-entry rule is satisfied as they go in.
  insert into scores (round_id, player_id, hole, strokes, entered_by)
  select c.round_id, c.player_id, c.hole, c.strokes,
         case when exists (select 1 from profiles p where p.id = c.entered_by)
              then c.entered_by else auth.uid() end
    from cleared_scores c
   where c.batch = batch_id
     and exists (select 1 from profiles p where p.id = c.player_id)
   order by c.player_id, c.hole;

  get diagnostics restored = row_count;

  delete from cleared_scores where batch = batch_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'restore_scores', 'round', in_round_id::text,
          jsonb_build_object('restored', restored, 'batch', batch_id));

  return restored;
end;
$function$;

-- owner_set_round_counts: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.owner_set_round_counts(in_round_id uuid, in_counts boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  week_name text;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can change what counts.'
      using errcode = 'insufficient_privilege';
  end if;

  update rounds set counts_for_standings = coalesce(in_counts, true)
   where id = in_round_id
  returning name into week_name;

  if week_name is null then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('name', week_name, 'counts_for_standings', coalesce(in_counts, true)));
end;
$function$;

-- owner_update_round: An admin of the club the week belongs to.
CREATE OR REPLACE FUNCTION public.owner_update_round(in_round_id uuid, in_name text, in_played_on date, in_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can edit a week.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the week a name.' using errcode = 'check_violation';
  end if;

  if in_played_on is null then
    raise exception 'Pick a date.' using errcode = 'check_violation';
  end if;

  if in_status not in ('setup', 'live', 'final') then
    raise exception 'Status is setting up, live or final.'
      using errcode = 'check_violation';
  end if;

  update rounds
     set name = btrim(in_name), played_on = in_played_on, status = in_status
   where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'round', in_round_id::text,
          jsonb_build_object('name', btrim(in_name), 'played_on', in_played_on,
                             'status', in_status));
end;
$function$;

-- admin_delete_group: An admin of the club the group's week belongs to.
CREATE OR REPLACE FUNCTION public.admin_delete_group(in_tee_time_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_club_admin(round_club(tee_time_round(in_tee_time_id))) then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from tee_time_players where tee_time_id = in_tee_time_id) then
    raise exception 'Move the players out of this group first.'
      using errcode = 'check_violation';
  end if;

  delete from tee_times where id = in_tee_time_id;

  if not found then
    raise exception 'No such group.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'delete', 'group', in_tee_time_id::text, null);
end;
$function$;

-- admin_set_group_seats: An admin of the club the group's week belongs to.
CREATE OR REPLACE FUNCTION public.admin_set_group_seats(in_tee_time_id uuid, in_seats integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  taken integer;
begin
  if not is_club_admin(round_club(tee_time_round(in_tee_time_id))) then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_seats is null or in_seats not between 2 and 4 then
    raise exception 'A tee time holds two, three or four.' using errcode = 'check_violation';
  end if;

  select count(*) into taken from tee_time_players where tee_time_id = in_tee_time_id;

  if taken > in_seats then
    raise exception 'That group has % in it already. Move somebody out first.', taken
      using errcode = 'check_violation';
  end if;

  update tee_times set seats = in_seats where id = in_tee_time_id;

  if not found then
    raise exception 'No such group.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'group', in_tee_time_id::text,
          jsonb_build_object('seats', in_seats));
end;
$function$;

-- admin_set_group_time: An admin of the club the group's week belongs to.
CREATE OR REPLACE FUNCTION public.admin_set_group_time(in_tee_time_id uuid, in_tee_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_club_admin(round_club(tee_time_round(in_tee_time_id))) then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_tee_at is null then
    raise exception 'Give the group a tee time.' using errcode = 'check_violation';
  end if;

  update tee_times set tee_at = in_tee_at where id = in_tee_time_id;

  if not found then
    raise exception 'No such group.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'group', in_tee_time_id::text,
          jsonb_build_object('tee_at', in_tee_at));
end;
$function$;

-- admin_place_player: An admin of the week's club, placing somebody who plays in that league.
CREATE OR REPLACE FUNCTION public.admin_place_player(in_round_id uuid, in_player_id uuid, in_tee_time_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  old_tee uuid;
  taken   integer;
  room    integer;
  who     text;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  select full_name into who from profiles where id = in_player_id;

  if who is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  if not exists (select 1 from league_members
                  where league_id = round_league(in_round_id)
                    and profile_id = in_player_id
                    and status = 'active') then
    raise exception '% isn''t in this league.', who using errcode = 'check_violation';
  end if;

  if in_tee_time_id is not null
     and not exists (select 1 from tee_times
                      where id = in_tee_time_id and round_id = in_round_id) then
    raise exception 'That group isn''t in this week.'
      using errcode = 'check_violation';
  end if;

  select tee_time_id into old_tee
    from tee_time_players
   where round_id = in_round_id and player_id = in_player_id;

  if old_tee is not distinct from in_tee_time_id then
    return;
  end if;

  if in_tee_time_id is not null then
    select seats into room from tee_times where id = in_tee_time_id;
    select count(*) into taken from tee_time_players where tee_time_id = in_tee_time_id;

    if taken >= coalesce(room, 4) then
      raise exception 'That group is full: it holds %. Give it another seat, or pick a different group.',
        coalesce(room, 4)
        using errcode = 'check_violation';
    end if;
  end if;

  delete from tee_time_players where round_id = in_round_id and player_id = in_player_id;

  if in_tee_time_id is not null then
    insert into tee_time_players (tee_time_id, round_id, player_id, position)
    values (
      in_tee_time_id, in_round_id, in_player_id,
      coalesce((select max(position) + 1 from tee_time_players
                 where tee_time_id = in_tee_time_id), 0)
    );

    perform rebuild_scoring_ring(in_tee_time_id);
  end if;

  if old_tee is not null then
    perform rebuild_scoring_ring(old_tee);
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'pairing', in_player_id::text,
          jsonb_build_object('name', who, 'round_id', in_round_id,
                             'from', old_tee, 'to', in_tee_time_id));
end;
$function$;

-- admin_add_guest: An admin of the week's club; the guest joins that club and league, so the people they play with can see them.
CREATE OR REPLACE FUNCTION public.admin_add_guest(in_round_id uuid, in_tee_time_id uuid, in_name text, in_handicap numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  guest uuid := gen_random_uuid();
  clean text := btrim(coalesce(in_name, ''));
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only an admin can add a guest.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(clean) not between 2 and 80 then
    raise exception 'Give the guest a name.' using errcode = 'check_violation';
  end if;

  if in_handicap is not null and (in_handicap < -10 or in_handicap > 54) then
    raise exception 'A handicap index runs from +10 to 54.'
      using errcode = 'check_violation';
  end if;

  insert into profiles (id, full_name, handicap_index, is_guest)
  values (guest, clean, round(in_handicap, 1), true);

  insert into club_members (club_id, profile_id, role, status, decided_at, decided_by)
  values (round_club(in_round_id), guest, 'player', 'active', now(), auth.uid());

  insert into league_members (league_id, profile_id, status, decided_at, decided_by)
  values (round_league(in_round_id), guest, 'active', now(), auth.uid());

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'guest', guest::text,
          jsonb_build_object('name', clean, 'round_id', in_round_id));

  if in_tee_time_id is not null then
    perform admin_place_player(in_round_id, guest, in_tee_time_id);
  end if;

  return guest;
end;
$function$;

-- enforce_sequential_holes: Holes may be filled out of order by whoever may correct scores in the round's club: an admin, or staff the admin allows.
CREATE OR REPLACE FUNCTION public.enforce_sequential_holes()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  entered_before int;
  first_hole     int;
  last_hole      int;
begin
  if can_fix_scores(round_club(new.round_id)) then
    return new;
  end if;

  select start_hole, start_hole + hole_count - 1
    into first_hole, last_hole
    from rounds where id = new.round_id;

  first_hole := coalesce(first_hole, 1);

  if new.hole < first_hole or new.hole > coalesce(last_hole, new.hole) then
    raise exception 'This week is holes % to %.', first_hole, last_hole
      using errcode = 'check_violation';
  end if;

  select count(*) into entered_before
    from scores
   where round_id = new.round_id
     and player_id = new.player_id
     and hole >= first_hole
     and hole < new.hole;

  if entered_before <> new.hole - first_hole then
    raise exception
      'Hole % cannot be entered yet: holes %-% must be filled in first.',
      new.hole, first_hole, new.hole - 1
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

-- enter_team_score: Scoring for a group other than your own is for whoever may correct scores in the round's club.
CREATE OR REPLACE FUNCTION public.enter_team_score(in_round_id uuid, in_tee_time_id uuid, in_hole integer, in_strokes integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  week  rounds%rowtype;
  me    uuid := auth.uid();
  last  integer;
  wrote integer;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if week.game <> 'scramble' then
    raise exception 'This week isn''t a scramble, so every player posts their own card.'
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from tee_times
                  where id = in_tee_time_id and round_id = in_round_id) then
    raise exception 'That group isn''t in this week.' using errcode = 'check_violation';
  end if;

  if not can_fix_scores(round_club(in_round_id))
     and not exists (select 1 from tee_time_players
                      where tee_time_id = in_tee_time_id and player_id = me) then
    raise exception 'You can only post a score for your own group.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_strokes is null or in_strokes not between 1 and 20 then
    raise exception 'A hole is 1 to 20 strokes.' using errcode = 'check_violation';
  end if;

  last := week.start_hole + week.hole_count - 1;

  if in_hole is null or in_hole < week.start_hole or in_hole > last then
    raise exception 'This week is holes % to %.', week.start_hole, last
      using errcode = 'check_violation';
  end if;

  insert into scores (round_id, player_id, hole, strokes, entered_by)
  select in_round_id, ttp.player_id, in_hole, in_strokes, me
    from tee_time_players ttp
   where ttp.tee_time_id = in_tee_time_id
  on conflict (round_id, player_id, hole)
    do update set strokes    = excluded.strokes,
                  entered_by = excluded.entered_by,
                  updated_at = now();

  get diagnostics wrote = row_count;

  if wrote = 0 then
    raise exception 'That group has nobody in it yet.' using errcode = 'check_violation';
  end if;

  return wrote;
end;
$function$;

-- set_rsvp: Answering for somebody else, or after the lock, is for an admin of the week's club; and only somebody in the league can answer at all.
CREATE OR REPLACE FUNCTION public.set_rsvp(in_round_id uuid, in_status text, in_player_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me uuid := auth.uid(); target uuid := coalesce(in_player_id, auth.uid());
        locked timestamptz;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;
  if target <> me and not is_club_admin(round_club(in_round_id)) then
    raise exception 'You can only change your own RSVP.' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from league_members
                  where league_id = round_league(in_round_id)
                    and profile_id = target
                    and status = 'active') then
    raise exception 'Only players in this league can answer for this week.'
      using errcode = 'insufficient_privilege';
  end if;

  select rsvp_lock_at into locked from rounds where id = in_round_id;
  if locked is not null and locked <= now() and not is_club_admin(round_club(in_round_id)) then
    raise exception 'Pairings are set for this round. Contact the admin to change your RSVP.'
      using errcode = 'check_violation';
  end if;

  insert into round_rsvps (round_id, player_id, status, set_by)
  values (in_round_id, target, in_status::rsvp_status, me)
  on conflict (round_id, player_id) do update
    set status = excluded.status, set_by = excluded.set_by;

  return jsonb_build_object('round_id', in_round_id, 'player_id', target, 'status', in_status);
end;
$function$;

-- round_completion: Nothing for a week in a league the caller can't see.
CREATE OR REPLACE FUNCTION public.round_completion(in_round_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'holeCount', (select hole_count from rounds where id = in_round_id),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'playerId', ttp.player_id,
               'name', pr.full_name,
               'posted', (select count(*) from scores s
                           where s.round_id = in_round_id and s.player_id = ttp.player_id)
             ) order by pr.full_name)
        from tee_time_players ttp join profiles pr on pr.id = ttp.player_id
       where ttp.round_id = in_round_id), '[]'::jsonb))
   where sees_league(round_league(in_round_id));
$function$;

-- owner_restorable_scores: Only weeks in clubs the caller runs.
CREATE OR REPLACE FUNCTION public.owner_restorable_scores()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_owner() then
    raise exception 'Only the league owner can see cleared scores.'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'roundId',   l.round_id,
             'count',     l.n,
             'clearedAt', l.cleared_at))
      from (
        select distinct on (c.round_id) c.round_id, c.batch, c.cleared_at,
               count(*) over (partition by c.batch) as n
          from cleared_scores c
         where c.cleared_at >= now() - interval '7 days'
           and is_club_admin(round_club(c.round_id))
         order by c.round_id, c.cleared_at desc
      ) as l
     where not exists (select 1 from scores s where s.round_id = l.round_id)
  ), '[]'::jsonb);
end;
$function$;

-- owner_start_new_week: The week carried forward is the Saturday League's, and so is the closed season it checks, until a week is started for a league by name.
CREATE OR REPLACE FUNCTION public.owner_start_new_week(in_name text, in_played_on date, in_copy_groups boolean DEFAULT true, in_course_id uuid DEFAULT NULL::uuid, in_hole_count integer DEFAULT NULL::integer, in_start_hole integer DEFAULT NULL::integer, in_game text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prev       rounds%rowtype;
  new_round  uuid;
  shift      interval;
  tt         record;
  new_tee    uuid;
  course     uuid;
  course_max integer;
  holes      integer;
  start      integer;
  week_game  text;
  points     smallint[];
  stake      integer := coalesce((select default_skins_stake from league_settings), 0);
begin
  if not is_owner() then
    raise exception 'Only the league owner can start a new week.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the week a name.' using errcode = 'check_violation';
  end if;

  select * into prev
    from rounds where league_id = 'b0000000-0000-4000-8000-000000000001'
   order by played_on desc, created_at desc limit 1;

  if not found then
    raise exception 'There is no week to carry forward yet.'
      using errcode = 'no_data_found';
  end if;

  if in_played_on is null or in_played_on <= prev.played_on then
    raise exception 'The new week has to come after %.', prev.played_on
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from seasons where league_id = 'b0000000-0000-4000-8000-000000000001'
                and year = extract(year from in_played_on)::integer) then
    raise exception 'The % season is closed. Reopen it on the admin page to add a week.',
      extract(year from in_played_on)::integer
      using errcode = 'check_violation';
  end if;

  course := coalesce(in_course_id, prev.course_id);

  if in_course_id is not null then
    select hole_count into course_max from courses
     where id = in_course_id and club_id = 'a0000000-0000-4000-8000-000000000001';

    if course_max is null then
      raise exception 'No such course.' using errcode = 'no_data_found';
    end if;
  else
    select hole_count into course_max from courses where id = course;
  end if;

  holes := coalesce(
    in_hole_count,
    case when course is not distinct from prev.course_id then prev.hole_count
         else least(coalesce(course_max, 18), 18) end
  );

  if holes not in (9, 18) then
    raise exception 'A week is 9 or 18 holes.' using errcode = 'check_violation';
  end if;

  start := coalesce(
    in_start_hole,
    case when in_hole_count is null and course is not distinct from prev.course_id
         then prev.start_hole else 1 end
  );

  if start not in (1, 10) then
    raise exception 'A week starts on hole 1 or hole 10.' using errcode = 'check_violation';
  end if;

  if start = 10 and holes <> 9 then
    raise exception 'Only a nine can be played on the back.' using errcode = 'check_violation';
  end if;

  if start + holes - 1 > coalesce(course_max, 18) then
    raise exception 'That course only has % holes.', course_max using errcode = 'check_violation';
  end if;

  week_game := coalesce(in_game, (select default_game from league_settings), 'stroke');

  if week_game not in ('stroke', 'stableford', 'scramble', 'best_ball') then
    raise exception 'Pick stroke play, Stableford, best ball or a scramble.'
      using errcode = 'check_violation';
  end if;

  if week_game = 'stableford' then
    points := coalesce((select stableford_points from league_settings), '{5,4,3,2,1,0}');
  end if;

  -- rounds_get_settings creates this week's round_settings row.
  insert into rounds (name, played_on, hole_count, start_hole, status, course_id, format,
                      game, stableford_points)
  values (btrim(in_name), in_played_on, holes, start,
          case when in_copy_groups then 'live' else 'setup' end,
          course, prev.format, week_game, points)
  returning id into new_round;

  if in_copy_groups then
    shift := (in_played_on - prev.played_on) * interval '1 day';

    for tt in
      select id, tee_at, seats
        from tee_times where round_id = prev.id order by tee_at
    loop
      insert into tee_times (round_id, tee_at, starting_hole, seats)
      values (new_round, tt.tee_at + shift, start, tt.seats)
      returning id into new_tee;

      insert into tee_time_players (tee_time_id, round_id, player_id, position)
      select new_tee, new_round, player_id, position
        from tee_time_players where tee_time_id = tt.id;

      insert into scorer_assignments (tee_time_id, scored_player_id, scorer_player_id)
      select new_tee, scored_player_id, scorer_player_id
        from scorer_assignments where tee_time_id = tt.id;
    end loop;
  end if;

  update round_settings ns
     set skins_enabled = os.skins_enabled,
         skins_stake   = case when stake > 0 then stake else os.skins_stake end
    from round_settings os
   where ns.round_id = new_round
     and os.round_id = prev.id;

  update rounds set status = 'final' where id = prev.id and status <> 'final';

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'round', new_round::text,
          jsonb_build_object('name', btrim(in_name), 'played_on', in_played_on,
                             'carried_from', prev.id, 'copied_groups', in_copy_groups,
                             'course_id', course, 'holes', holes, 'start_hole', start,
                             'game', week_game));

  return new_round;
end;
$function$;

-- owner_reopen_season: The Saturday League's season.
CREATE OR REPLACE FUNCTION public.owner_reopen_season(in_year integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_owner() then
    raise exception 'Only the league owner can reopen a season.'
      using errcode = 'insufficient_privilege';
  end if;

  delete from seasons where year = in_year and league_id = 'b0000000-0000-4000-8000-000000000001';

  if not found then
    raise exception 'That season isn''t closed.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'reopen', 'season', in_year::text, '{}'::jsonb);
end;
$function$;

-- build_round: Groups the Saturday League's players, on one of PukaGolf's courses, rather than everyone who has ever signed up anywhere.
CREATE OR REPLACE FUNCTION public.build_round(round_name text, target_course uuid, group_size integer DEFAULT 4)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  new_round uuid; holes smallint; ids uuid[]; total int; group_count int;
  first_tee timestamptz := date_trunc('hour', now()) + interval '1 hour';
  g int; lo int; hi int; members uuid[]; tee uuid; i int;
begin
  if auth.uid() is not null and not is_admin() then
    raise exception 'Only an admin can build a round.';
  end if;

  if group_size < 2 then
    raise exception 'Groups need at least 2 players so scoring can rotate.';
  end if;

  select hole_count into holes from courses where id = target_course and club_id = 'a0000000-0000-4000-8000-000000000001';
  if holes is null then raise exception 'No such course.'; end if;

  select array_agg(p.id order by p.full_name) into ids
    from profiles p
   where exists (select 1 from league_members lm
                  where lm.profile_id = p.id and lm.league_id = 'b0000000-0000-4000-8000-000000000001'
                    and lm.status = 'active');
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
    if g = group_count - 1 then hi := total; end if;
    members := ids[lo:hi];

    insert into tee_times (round_id, tee_at, starting_hole)
    values (new_round, first_tee + (g * interval '10 minutes'), 1)
    returning id into tee;

    for i in 1 .. array_length(members, 1) loop
      insert into tee_time_players (tee_time_id, round_id, player_id, position)
      values (tee, new_round, members[i], i - 1);
      insert into scorer_assignments (tee_time_id, scored_player_id, scorer_player_id)
      values (tee, members[(i % array_length(members, 1)) + 1], members[i]);
    end loop;
  end loop;

  return new_round;
end;
$function$;

-- owner_league_overview: PukaGolf's weeks and PukaGolf's members, not every club's.
CREATE OR REPLACE FUNCTION public.owner_league_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  current_id uuid;
begin
  if not is_owner() then
    raise exception 'Only the league owner can open this.'
      using errcode = 'insufficient_privilege';
  end if;

  select id into current_id
    from rounds where league_id = 'b0000000-0000-4000-8000-000000000001'
   order by played_on desc, created_at desc limit 1;

  return jsonb_build_object(
    'currentRoundId', current_id,

    'rounds', coalesce((
      select jsonb_agg(x.r order by x.played desc, x.created desc)
        from (
          select rd.played_on as played,
                 rd.created_at as created,
                 jsonb_build_object(
                   'id',           rd.id,
                   'name',         rd.name,
                   'playedOn',     rd.played_on,
                   'status',       rd.status,
                   'courseName',   co.name,
                   'holeCount',    rd.hole_count,
                   'scoreCount',   (select count(*) from scores s where s.round_id = rd.id),
                   'playerCount',  (select count(*) from tee_time_players t where t.round_id = rd.id),
                   'feedCount',    (select count(*) from feed_posts f where f.round_id = rd.id),
                   'skinsEnabled', rs.skins_enabled,
                   'skinsStake',   rs.skins_stake
                 ) as r
            from rounds rd
            left join courses co on co.id = rd.course_id
            left join round_settings rs on rs.round_id = rd.id
           where rd.league_id = 'b0000000-0000-4000-8000-000000000001'
        ) as x
    ), '[]'::jsonb),

    'players', coalesce((
      select jsonb_agg(y.p order by y.name)
        from (
          select pr.full_name as name,
                 jsonb_build_object(
                   'id',             pr.id,
                   'name',           pr.full_name,
                   'isAdmin',        pr.is_admin,
                   'isOwner',        exists (select 1 from league_owner o where o.profile_id = pr.id),
                   'contact',        coalesce(nullif(u.email, ''), profile_phone(u.phone)),
                   'joined',         pr.created_at::date,
                   'handicapIndex',  pr.handicap_index,
                   'inCurrentRound', exists (
                     select 1 from tee_time_players t
                      where t.round_id = current_id and t.player_id = pr.id
                   ),
                   'roundsPlayed',   (
                     select count(distinct s.round_id) from scores s where s.player_id = pr.id
                   )
                 ) as p
            from profiles pr
            left join auth.users u on u.id = pr.id
           where exists (select 1 from club_members m
                          where m.profile_id = pr.id and m.club_id = 'a0000000-0000-4000-8000-000000000001'
                            and m.status = 'active')
        ) as y
    ), '[]'::jsonb),

    'demo', (
      select jsonb_build_object(
               'id', e.id,
               'name', e.name,
               'scoreCount', (select count(*) from event_scores es where es.event_id = e.id)
             )
        from events e
       where e.is_demo
       limit 1
    )
  );
end;
$function$;

-- league_season: The Saturday League's season, shown only to people who can see that league: its weeks, its players and its closed seasons, not every club's. A league is picked by name once the app knows more than one.
CREATE OR REPLACE FUNCTION public.league_season(in_year integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  season integer := coalesce(in_year, extract(year from current_date)::integer);
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if not sees_league('b0000000-0000-4000-8000-000000000001') then
    raise exception 'You aren''t in this league.' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'year', season,
    'leagueSkins', coalesce((select skins_enabled from league_settings), true),

    'rules', coalesce((
      select jsonb_build_object(
               'points',          points_table,
               'completionPoint', completion_point,
               'dropWorst',       drop_worst,
               'minWeeks',        min_weeks,
               'ranking',         ranking,
               'guestsScore',     guests_score,
               'defaultGame',     default_game,
               'stableford',      stableford_points)
        from league_settings
    ), '{}'::jsonb),

    'years', coalesce((
      select jsonb_agg(y.year order by y.year desc)
        from (select distinct extract(year from played_on)::integer as year
                from rounds where league_id = 'b0000000-0000-4000-8000-000000000001') as y
    ), '[]'::jsonb),

    'closed', (
      select jsonb_build_object(
               'closedAt',     s.closed_at,
               'championId',   s.champion_id,
               'championName', s.champion_name)
        from seasons s
       where s.year = season and s.league_id = 'b0000000-0000-4000-8000-000000000001'
    ),

    'players', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', p.id,
                 'name', p.full_name,
                 'handicapIndex', p.handicap_index,
                 'preferredTee', p.preferred_tee,
                 'isGuest', p.is_guest
               ) order by p.full_name)
        from profiles p
       where exists (select 1 from league_members lm
                      where lm.profile_id = p.id and lm.league_id = 'b0000000-0000-4000-8000-000000000001'
                        and lm.status in ('active', 'removed'))
    ), '[]'::jsonb),

    'rounds', coalesce((
      select jsonb_agg(w.entry order by w.played_on, w.created_at)
        from (
          select rd.played_on,
                 rd.created_at,
                 jsonb_build_object(
                   'id',                 rd.id,
                   'name',               rd.name,
                   'playedOn',           rd.played_on,
                   'status',             rd.status,
                   'holeCount',          rd.hole_count,
                   'startHole',          rd.start_hole,
                   'game',               rd.game,
                   'stablefordPoints',   rd.stableford_points,
                   'countsForStandings', rd.counts_for_standings,
                   'skinsEnabled',       coalesce(rs.skins_enabled, true),
                   'skinsStake',         coalesce(rs.skins_stake, 0),
                   'pars', coalesce((
                     select jsonb_object_agg(ch.hole::text, ch.par)
                       from course_holes ch where ch.course_id = rd.course_id
                   ), '{}'::jsonb),
                   'strokeIndexes', coalesce((
                     select jsonb_object_agg(ch.hole::text, ch.handicap_index)
                       from course_holes ch
                      where ch.course_id = rd.course_id
                        and ch.handicap_index is not null
                   ), '{}'::jsonb),
                   'tees', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'tee',          coalesce(ct.tee_color, ct.tee_key),
                                'courseRating', ct.course_rating,
                                'slope',        ct.slope,
                                'yardage',      ct.yardage))
                       from course_tees ct where ct.course_id = rd.course_id
                   ), '[]'::jsonb),
                   'groups', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id', t.id,
                                'seats', t.seats,
                                'playerIds', coalesce((
                                  select jsonb_agg(ttp.player_id order by ttp.position)
                                    from tee_time_players ttp where ttp.tee_time_id = t.id
                                ), '[]'::jsonb),
                                'playedTees', coalesce((
                                  select jsonb_object_agg(ttp.player_id::text, ttp.played_tee)
                                    from tee_time_players ttp
                                   where ttp.tee_time_id = t.id and ttp.played_tee is not null
                                ), '{}'::jsonb)
                              ) order by t.tee_at)
                       from tee_times t where t.round_id = rd.id
                   ), '[]'::jsonb),
                   'scores', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'playerId', s.player_id,
                                'hole',     s.hole,
                                'strokes',  s.strokes))
                       from scores s where s.round_id = rd.id
                   ), '[]'::jsonb)
                 ) as entry
            from rounds rd
            left join round_settings rs on rs.round_id = rd.id
           where extract(year from rd.played_on) = season
             and rd.league_id = 'b0000000-0000-4000-8000-000000000001'
        ) as w
    ), '[]'::jsonb)
  );
end;
$function$;

-- assert_league_event: An admin of the event's club.
CREATE OR REPLACE FUNCTION public.assert_league_event(in_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  kind text;
begin
  if not is_club_admin(event_club(in_event_id)) then
    raise exception 'Only an admin can change an event.'
      using errcode = 'insufficient_privilege';
  end if;

  select scope into kind from events where id = in_event_id;

  if kind is null then
    raise exception 'No such event.' using errcode = 'no_data_found';
  end if;

  -- An outing is administered through its own PIN, not from in here.
  if kind <> 'league' then
    raise exception 'That is an outing. Open it with its own link to change it.'
      using errcode = 'check_violation';
  end if;
end;
$function$;

-- admin_delete_event: An admin of the event's club.
CREATE OR REPLACE FUNCTION public.admin_delete_event(in_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  target events%rowtype;
  scores bigint;
begin
  if not is_club_admin(event_club(in_event_id)) then
    raise exception 'Admins only.' using errcode = 'insufficient_privilege';
  end if;

  select * into target from events where id = in_event_id;

  if not found then
    raise exception 'No such outing.' using errcode = 'no_data_found';
  end if;

  select count(*) into scores from event_scores where event_id = in_event_id;

  if target.completed_at is null
     and target.played_on >= current_date
     and scores > 0 then
    raise exception 'Someone may still be playing this. Close it out first.'
      using errcode = 'check_violation';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (
    auth.uid(), 'delete', 'event', in_event_id::text,
    jsonb_build_object(
      'name', target.name,
      'played_on', target.played_on,
      'score_count', scores,
      'completed_at', target.completed_at
    )
  );

  delete from events where id = in_event_id;
end;
$function$;

-- admin_set_event_pin: An admin of the event's club.
CREATE OR REPLACE FUNCTION public.admin_set_event_pin(in_event_id uuid, in_pin text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  chosen text := nullif(btrim(in_pin), '');
  pin    text;
  outing text;
begin
  if not is_club_admin(event_club(in_event_id)) then
    raise exception 'Only a league admin can change an outing''s PIN.'
      using errcode = 'insufficient_privilege';
  end if;
  select e.name into outing from events e where e.id = in_event_id;
  if outing is null then
    raise exception 'No such outing.' using errcode = 'no_data_found';
  end if;
  if chosen is null then
    pin := generate_event_pin();
  else
    if chosen !~ '^\d{8}$' then
      raise exception 'The admin PIN must be exactly 8 digits.'
        using errcode = 'check_violation';
    end if;
    if pin_is_weak(chosen) then
      raise exception
        'That PIN is too easy to guess. Avoid repeated digits and runs like 12345678.'
        using errcode = 'check_violation';
    end if;
    pin := chosen;
  end if;
  update events
     set admin_pin_hash   = crypt(pin, gen_salt('bf')),
         admin_token      = replace(gen_random_uuid()::text, '-', ''),
         pin_attempts     = 0,
         pin_locked_until = null
   where id = in_event_id;
  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'event', in_event_id::text,
          jsonb_build_object('name', outing, 'admin_pin', 'changed',
                             'generated', chosen is null));
  return jsonb_build_object('pin', pin, 'generated', chosen is null);
end;
$function$;

-- admin_event_invite: Only players in the event's league can be invited to it.
CREATE OR REPLACE FUNCTION public.admin_event_invite(in_event_id uuid, in_profile_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  added integer;
  seat  integer;
begin
  perform assert_league_event(in_event_id);

  select coalesce(max(position), -1) + 1 into seat
    from event_players where event_id = in_event_id;

  insert into event_players (event_id, name, position, profile_id, status)
  select in_event_id, p.full_name,
         seat + (row_number() over (order by p.full_name))::integer - 1,
         p.id, 'undecided'::rsvp_status
    from profiles p
   where p.id = any(in_profile_ids)
     and exists (select 1 from league_members lm
                   join events e on e.league_id = lm.league_id
                  where e.id = in_event_id and lm.profile_id = p.id
                    and lm.status = 'active')
     and not exists (select 1 from event_players x
                      where x.event_id = in_event_id and x.profile_id = p.id)
  on conflict do nothing;

  get diagnostics added = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'event', in_event_id::text,
          jsonb_build_object('invited', added));

  return added;
end;
$function$;

-- event_rsvp: Answering for somebody else is for an admin of the event's club.
CREATE OR REPLACE FUNCTION public.event_rsvp(in_event_id uuid, in_status text, in_player_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  seat uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if in_status not in ('in', 'out', 'undecided') then
    raise exception 'An answer is in, out or undecided.' using errcode = 'check_violation';
  end if;

  if in_player_id is null then
    select id into seat from event_players
     where event_id = in_event_id and profile_id = auth.uid();

    if seat is null then
      raise exception 'You are not invited to that event.'
        using errcode = 'insufficient_privilege';
    end if;
  else
    if not is_club_admin(event_club(in_event_id)) then
      raise exception 'Only an admin can answer for somebody else.'
        using errcode = 'insufficient_privilege';
    end if;
    seat := in_player_id;
  end if;

  update event_players set status = in_status::rsvp_status
   where id = seat and event_id = in_event_id;
end;
$function$;

-- league_event: Only for somebody who can see the event's league; to anyone else it doesn't exist.
CREATE OR REPLACE FUNCTION public.league_event(in_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  target events%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  select * into target from events
   where id = in_event_id and scope = 'league' and sees_league(league_id);

  if not found then
    raise exception 'No such event.' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', target.id,
      'name', target.name,
      'playedOn', target.played_on,
      'formatId', target.format_id,
      'teamSize', target.team_size,
      'holeCount', target.hole_count,
      'startHole', target.start_hole,
      'isSimulator', target.is_simulator,
      'countsForStandings', target.counts_for_standings,
      'courseId', target.course_id,
      'courseName', target.course_name,
      'skinsEnabled', target.skins_enabled,
      'skinsStake', target.skins_stake
    ),
    'roster', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', ep.id,
                 'profileId', ep.profile_id,
                 'name', ep.name,
                 'position', ep.position,
                 'status', ep.status,
                 'isGuest', ep.profile_id is null,
                 'handicapIndex', pr.handicap_index,
                 'preferredTee', pr.preferred_tee,
                 'playedTee', ep.played_tee
               ) order by ep.position, ep.name)
        from event_players ep
        left join profiles pr on pr.id = ep.profile_id
       where ep.event_id = target.id
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', t.id, 'name', t.name, 'position', t.position,
                 'memberIds', coalesce((
                   select jsonb_agg(m.player_id)
                     from event_team_members m where m.team_id = t.id
                 ), '[]'::jsonb)
               ) order by t.position)
        from event_teams t where t.event_id = target.id
    ), '[]'::jsonb),
    'teeTimes', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', tt.id, 'teeAt', tt.tee_at, 'position', tt.position,
                 'teamIds', coalesce((
                   select jsonb_agg(x.team_id order by x.position)
                     from event_tee_time_teams x where x.tee_time_id = tt.id
                 ), '[]'::jsonb)
               ) order by tt.tee_at, tt.position)
        from event_tee_times tt where tt.event_id = target.id
    ), '[]'::jsonb),
    'scores', coalesce((
      select jsonb_agg(
               jsonb_build_object('teamId', s.team_id, 'playerId', s.player_id,
                                  'hole', s.hole, 'strokes', s.strokes))
        from event_scores s where s.event_id = target.id
    ), '[]'::jsonb),
    'pars', coalesce((
      select jsonb_object_agg(ch.hole::text, ch.par)
        from course_holes ch where ch.course_id = target.course_id
    ), '{}'::jsonb),
    'strokeIndexes', coalesce((
      select jsonb_object_agg(ch.hole::text, ch.handicap_index)
        from course_holes ch
       where ch.course_id = target.course_id and ch.handicap_index is not null
    ), '{}'::jsonb),
    'tees', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'tee', coalesce(ct.tee_color, ct.tee_key),
                 'courseRating', ct.course_rating,
                 'slope', ct.slope,
                 'yardage', ct.yardage))
        from course_tees ct where ct.course_id = target.course_id
    ), '[]'::jsonb)
  );
end;
$function$;

-- league_events: Events in leagues the caller can see.
CREATE OR REPLACE FUNCTION public.league_events()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id', e.id,
               'name', e.name,
               'playedOn', e.played_on,
               'formatId', e.format_id,
               'teamSize', e.team_size,
               'holeCount', e.hole_count,
               'isSimulator', e.is_simulator,
               'countsForStandings', e.counts_for_standings,
               'courseName', e.course_name,
               'players', (select count(*) from event_players p where p.event_id = e.id),
               'in', (select count(*) from event_players p
                       where p.event_id = e.id and p.status = 'in'),
               'teams', (select count(*) from event_teams t where t.event_id = e.id),
               'scores', (select count(*) from event_scores s where s.event_id = e.id)
             ) order by e.played_on desc, e.created_at desc)
      from events e where e.scope = 'league' and sees_league(e.league_id)
  ), '[]'::jsonb);
end;
$function$;

-- admin_events: Events in clubs the caller runs.
CREATE OR REPLACE FUNCTION public.admin_events()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then
    raise exception 'Admins only.' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(payload order by played_on desc, created_at desc)
      from (
        select e.played_on, e.created_at,
               jsonb_build_object(
                 'id', e.id, 'name', e.name, 'playedOn', e.played_on,
                 'format', e.format, 'holeCount', e.hole_count,
                 'courseName', e.course_name, 'shareToken', e.share_token,
                 'completedAt', e.completed_at, 'createdAt', e.created_at,
                 'isDemo', e.is_demo,
                 'playerCount', (select count(*) from event_players p where p.event_id = e.id),
                 'scoreCount', (select count(*) from event_scores s where s.event_id = e.id),
                 'lastScoreAt', (select max(s.updated_at) from event_scores s where s.event_id = e.id)
               ) as payload
          from events e
         where is_club_admin(e.club_id)
      ) as rows
  ), '[]'::jsonb);
end;
$function$;

-- owner_create_league_event: A league event is the Saturday League's, said explicitly: league_id has no default, because an outing has none.
CREATE OR REPLACE FUNCTION public.owner_create_league_event(in_name text, in_played_on date, in_course_id uuid DEFAULT NULL::uuid, in_hole_count integer DEFAULT 18, in_start_hole integer DEFAULT 1, in_is_simulator boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  fresh uuid;
  holes integer := coalesce(in_hole_count, 18);
begin
  if not is_admin() then
    raise exception 'Only an admin can create an event.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the event a name.' using errcode = 'check_violation';
  end if;

  if in_played_on is null then
    raise exception 'Give the event a date.' using errcode = 'check_violation';
  end if;

  if holes not in (9, 18) then
    raise exception 'An event is 9 or 18 holes.' using errcode = 'check_violation';
  end if;

  if coalesce(in_start_hole, 1) not in (1, 10) then
    raise exception 'An event starts on hole 1 or hole 10.' using errcode = 'check_violation';
  end if;

  insert into events (club_id, league_id,
                      name, played_on, format, format_id, team_size, scope,
                      hole_count, start_hole, is_simulator, course_id, course_name,
                      created_by)
  values ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
          btrim(in_name), in_played_on, 'solo', 'stroke', 1, 'league',
          holes, coalesce(in_start_hole, 1), coalesce(in_is_simulator, false),
          in_course_id,
          (select name from courses where id = in_course_id),
          auth.uid())
  returning id into fresh;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'event', fresh::text,
          jsonb_build_object('name', btrim(in_name), 'played_on', in_played_on,
                             'scope', 'league', 'simulator', coalesce(in_is_simulator, false)));

  return fresh;
end;
$function$;

-- player_rounds: Only rounds the caller may see this player's score in: sees_score_of().
CREATE OR REPLACE FUNCTION public.player_rounds(in_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           and sees_score_of(in_player_id, rd.league_id)
      ) as r
  ), '[]'::jsonb);
end;
$function$;

-- player_event_rounds: Only events the caller may see this player's score in.
CREATE OR REPLACE FUNCTION public.player_event_rounds(in_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(r order by r.played_on desc)
      from (
        select jsonb_build_object(
                 'roundId',    ev.id,
                 'name',       ev.name,
                 'playedOn',   ev.played_on,
                 'status',     'final',
                 'courseName', coalesce(co.name, ev.course_name),
                 'holeCount',  ev.hole_count,
                 'startHole',  ev.start_hole,
                 'tee', coalesce(
                          ep.played_tee,
                          resolve_tee_preference(ev.course_id, pr.preferred_tee)
                        ),
                 'courseRating', ct.course_rating,
                 'slope', ct.slope,
                 'coursePar', (
                   select sum(ch.par) from course_holes ch
                    where ch.course_id = ev.course_id
                 ),
                 'scores', coalesce((
                   select jsonb_object_agg(s.hole::text, s.strokes)
                     from event_scores s
                    where s.event_id = ev.id and s.player_id = ep.id
                 ), '{}'::jsonb),
                 'pars', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.par)
                     from course_holes ch where ch.course_id = ev.course_id
                 ), '{}'::jsonb),
                 'strokeIndexes', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.handicap_index)
                     from course_holes ch
                    where ch.course_id = ev.course_id
                      and ch.handicap_index is not null
                 ), '{}'::jsonb),
                 'isSimulator', ev.is_simulator,
                 'isEvent', true
               ) as r,
               ev.played_on
          from events ev
          join event_players ep
            on ep.event_id = ev.id and ep.profile_id = in_player_id
          join profiles pr on pr.id = in_player_id
          left join courses co on co.id = ev.course_id
          left join lateral (
            select ct2.course_rating, ct2.slope
              from course_tees ct2
             where ct2.course_id = ev.course_id
               and lower(coalesce(ct2.tee_color, ct2.tee_key))
                   = lower(coalesce(
                       ep.played_tee,
                       resolve_tee_preference(ev.course_id, pr.preferred_tee),
                       ''
                     ))
             order by ct2.yardage desc nulls last
             limit 1
          ) ct on true
         where ev.scope = 'league'
           and sees_score_of(in_player_id, ev.league_id)
           -- Own ball only: a shared card is nobody's own score.
           and ev.format_id not in ('scramble', 'alt_shot', 'greensomes')
           and exists (
             select 1 from event_scores s
              where s.event_id = ev.id and s.player_id = ep.id
           )
      ) as r
  ), '[]'::jsonb);
end;
$function$;

-- player_team_events: Only events the caller may see this player's score in.
CREATE OR REPLACE FUNCTION public.player_team_events(in_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(e order by e.played_on desc)
      from (
        select jsonb_build_object(
                 'eventId',    ev.id,
                 'name',       ev.name,
                 'playedOn',   ev.played_on,
                 'courseName', coalesce(co.name, ev.course_name),
                 'formatId',   ev.format_id,
                 'teamSize',   ev.team_size,
                 'holeCount',  ev.hole_count,
                 'startHole',  ev.start_hole,
                 'isSimulator', ev.is_simulator,
                 'myTeamId',   mine.team_id,
                 'pars', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.par)
                     from course_holes ch where ch.course_id = ev.course_id
                 ), '{}'::jsonb),
                 'teams', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'id', t.id,
                              'name', t.name,
                              'position', t.position,
                              'members', coalesce((
                                select jsonb_agg(
                                         jsonb_build_object('id', ep2.id, 'name', ep2.name)
                                         order by ep2.position, ep2.name)
                                  from event_team_members m
                                  join event_players ep2 on ep2.id = m.player_id
                                 where m.team_id = t.id
                              ), '[]'::jsonb)
                            ) order by t.position)
                     from event_teams t where t.event_id = ev.id
                 ), '[]'::jsonb),
                 'scores', coalesce((
                   select jsonb_agg(
                            jsonb_build_object('teamId', s.team_id,
                                               'playerId', s.player_id,
                                               'hole', s.hole,
                                               'strokes', s.strokes))
                     from event_scores s where s.event_id = ev.id
                 ), '[]'::jsonb)
               ) as e,
               ev.played_on
          from events ev
          join event_players ep
            on ep.event_id = ev.id and ep.profile_id = in_player_id
          join event_team_members mine on mine.player_id = ep.id
          left join courses co on co.id = ev.course_id
         where ev.scope = 'league'
           and sees_score_of(in_player_id, ev.league_id)
           and ev.team_size > 1
           and exists (select 1 from event_scores s where s.event_id = ev.id)
      ) as e
  ), '[]'::jsonb);
end;
$function$;

-- set_tournament_rsvp: Admin overrides are for an admin of the tournament's club, and only its members can enter.
CREATE OR REPLACE FUNCTION public.set_tournament_rsvp(in_tournament_id uuid, in_status text, in_player_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me uuid := auth.uid(); target uuid := coalesce(in_player_id, auth.uid());
        t tournaments%rowtype; entered int;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;
  if target <> me and not is_club_admin(tournament_club(in_tournament_id)) then
    raise exception 'You can only change your own entry.' using errcode = 'insufficient_privilege';
  end if;

  select * into t from tournaments where id = in_tournament_id;
  if t.id is null then
    raise exception 'No such tournament.' using errcode = 'no_data_found';
  end if;

  if not exists (select 1 from club_members
                  where club_id = t.club_id and profile_id = target and status = 'active') then
    raise exception 'Only members of this club can enter.' using errcode = 'insufficient_privilege';
  end if;

  if t.rsvp_lock_at is not null and t.rsvp_lock_at <= now() and not is_club_admin(t.club_id) then
    raise exception 'Entries have closed for this tournament. Contact the admin.'
      using errcode = 'check_violation';
  end if;

  if in_status = 'in' and t.field_limit is not null and not is_club_admin(t.club_id) then
    select count(*) into entered from tournament_rsvps
     where tournament_id = in_tournament_id and status = 'in' and player_id <> target;
    if entered >= t.field_limit then
      raise exception 'This tournament is full (% players).', t.field_limit
        using errcode = 'check_violation';
    end if;
  end if;

  insert into tournament_rsvps (tournament_id, player_id, status, set_by)
  values (in_tournament_id, target, in_status::rsvp_status, me)
  on conflict (tournament_id, player_id) do update
    set status = excluded.status, set_by = excluded.set_by;

  return jsonb_build_object('tournament_id', in_tournament_id,
                            'player_id', target, 'status', in_status);
end;
$function$;

-- charity_totals: Charities of clubs the caller belongs to.
CREATE OR REPLACE FUNCTION public.charity_totals()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
           jsonb_agg(t_row.payload order by t_row.position, t_row.name),
           '[]'::jsonb
         )
    from (
      select ch.position,
             ch.name,
             jsonb_build_object(
               'id', ch.id,
               'name', ch.name,
               'description', ch.description,
               'logoUrl', ch.logo_url,
               'website', ch.website,
               'active', ch.active,
               'seasonTotal', coalesce((
                 select sum(t.raised) from tournaments t
                  where t.charity_id = ch.id
                    and extract(year from t.played_on) = extract(year from now())
               ), 0),
               'allTimeTotal', coalesce((
                 select sum(t.raised) from tournaments t
                  where t.charity_id = ch.id
               ), 0),
               'events', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id', t.id,
                            'name', t.name,
                            'playedOn', t.played_on,
                            'raised', t.raised
                          ) order by t.played_on desc
                        )
                   from tournaments t
                  where t.charity_id = ch.id and t.raised > 0
               ), '[]'::jsonb)
             ) as payload
        from charities ch
       where is_club_member(ch.club_id)
    ) as t_row;
$function$;

-- owner_set_handicap: For a player in a club the caller runs, by that club's admin.
CREATE OR REPLACE FUNCTION public.owner_set_handicap(in_profile_id uuid, in_index numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  who text;
begin
  if auth.uid() is null then
    raise exception 'Only the league owner can set a handicap.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from club_members m
                  where m.profile_id = in_profile_id and is_club_admin(m.club_id)) then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  if in_index is not null and (in_index < -10 or in_index > 54) then
    raise exception 'A handicap index runs from +10 to 54.'
      using errcode = 'check_violation';
  end if;

  update profiles set handicap_index = round(in_index, 1)
   where id = in_profile_id
  returning full_name into who;

  if who is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'handicap', in_profile_id::text,
          jsonb_build_object('name', who, 'handicap_index', round(in_index, 1)));
end;
$function$;

-- owner_update_player: For a player in a club the caller runs. A name and a number belong to the person in every club, and the number is their login, so a player who is also in a club the caller doesn't run is the platform admin's to change.
CREATE OR REPLACE FUNCTION public.owner_update_player(in_profile_id uuid, in_full_name text, in_phone text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  clean   text := btrim(coalesce(in_full_name, ''));
  wanted  text := nullif(btrim(coalesce(in_phone, '')), '');
  holder  text;
  before  profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Only the league owner can edit a player.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from club_members m
                  where m.profile_id = in_profile_id and is_club_admin(m.club_id)) then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  if not is_platform_admin()
     and exists (select 1 from club_members m
                  where m.profile_id = in_profile_id
                    and m.status in ('active', 'requested')
                    and not is_club_admin(m.club_id)) then
    raise exception 'This player is also in another club, so only the PukaGolf owner can change their name or number.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into before from profiles where id = in_profile_id;

  if before.id is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  if length(clean) not between 2 and 80 then
    raise exception 'Enter a first and last name.' using errcode = 'check_violation';
  end if;

  if wanted is not null and wanted !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'Enter a 10-digit US mobile number.' using errcode = 'check_violation';
  end if;

  if wanted is not null and wanted is distinct from before.phone then
    select p.full_name into holder
      from profiles p
     where p.id <> in_profile_id
       and (p.phone = wanted
            or exists (select 1 from auth.users u
                        where u.id = p.id and u.phone = ltrim(wanted, '+')));

    if holder is not null then
      raise exception '% already uses that number.', holder
        using errcode = 'unique_violation';
    end if;

    if exists (select 1 from auth.users where id = in_profile_id) then
      update auth.users set phone = ltrim(wanted, '+') where id = in_profile_id;
    end if;

    update profiles set phone = wanted where id = in_profile_id;
  end if;

  update profiles set full_name = clean where id = in_profile_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'player', in_profile_id::text,
          jsonb_build_object('from', jsonb_build_object('name', before.full_name, 'phone', before.phone),
                             'to', jsonb_build_object('name', clean,
                                                      'phone', coalesce(wanted, before.phone))));
end;
$function$;

-- owner_set_admin: PukaGolf's admins are its club_members rows now; profiles.is_admin is kept in step because the app still reads it to show the admin pages.
CREATE OR REPLACE FUNCTION public.owner_set_admin(in_profile_id uuid, in_is_admin boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_owner() then
    raise exception 'Only the league owner can change who is an admin.'
      using errcode = 'insufficient_privilege';
  end if;

  if not in_is_admin
     and exists (select 1 from league_owner where profile_id = in_profile_id) then
    raise exception 'The owner is always an admin.'
      using errcode = 'check_violation';
  end if;

  update club_members
     set role = case when in_is_admin then 'admin' else 'player' end,
         staff_can_edit_scores = false
   where club_id = 'a0000000-0000-4000-8000-000000000001' and profile_id = in_profile_id and status = 'active';

  if not found then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  update profiles set is_admin = in_is_admin where id = in_profile_id;

  if not found then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'player', in_profile_id::text,
          jsonb_build_object('is_admin', in_is_admin));
end;
$function$;

-- make_admin: Makes the account an admin of PukaGolf, where admins now live.
CREATE OR REPLACE FUNCTION public.make_admin(user_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare target uuid;
begin
  select id into target from auth.users where email = user_email;
  if target is null then
    raise exception 'No user signed up with %.', user_email;
  end if;
  update profiles set is_admin = true where id = target;

  insert into club_members (club_id, profile_id, role, status, decided_at)
  values ('a0000000-0000-4000-8000-000000000001', target, 'admin', 'active', now())
  on conflict (club_id, profile_id) do update
    set role = 'admin', status = 'active', staff_can_edit_scores = false;
end;
$function$;

-- make_admin_by_phone: Makes the account an admin of PukaGolf, where admins now live.
CREATE OR REPLACE FUNCTION public.make_admin_by_phone(user_phone text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  wanted text := profile_phone(user_phone);
  target uuid;
begin
  select id into target
    from auth.users
   where profile_phone(phone) = wanted;

  if target is null then
    raise exception 'No account signed up with %.', wanted;
  end if;

  update profiles set is_admin = true where id = target;

  insert into club_members (club_id, profile_id, role, status, decided_at)
  values ('a0000000-0000-4000-8000-000000000001', target, 'admin', 'active', now())
  on conflict (club_id, profile_id) do update
    set role = 'admin', status = 'active', staff_can_edit_scores = false;
end;
$function$;

-- handle_new_user: A new account joins PukaGolf and its Saturday League, as signing up did before clubs. Joining a club by its link and the pro shop's approval replaces this; until then it keeps PukaGolf's signup working.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into profiles (id, full_name, phone, phone_verified)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      new.email,
      profile_phone(new.phone),
      'New player'
    ),
    profile_phone(new.phone),
    new.phone_confirmed_at is not null
  )
  on conflict (id) do nothing;

  insert into club_members (club_id, profile_id, role, status, decided_at)
  values ('a0000000-0000-4000-8000-000000000001', new.id, 'player', 'active', now())
  on conflict do nothing;

  insert into league_members (league_id, profile_id, status, decided_at)
  values ('b0000000-0000-4000-8000-000000000001', new.id, 'active', now())
  on conflict do nothing;

  return new;
end;
$function$;

-- owner_remove_player: Deleting an account removes the person from every club, so it is the platform admin's. A club admin removes a player from their own club instead.
CREATE OR REPLACE FUNCTION public.owner_remove_player(in_profile_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  who      text;
  affected uuid[];
  t        uuid;
begin
  if not is_platform_admin() then
    raise exception 'Only the league owner can remove a player.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_profile_id = auth.uid()
     or exists (select 1 from league_owner where profile_id = in_profile_id) then
    raise exception 'The owner can''t be removed.'
      using errcode = 'check_violation';
  end if;

  select full_name into who from profiles where id = in_profile_id;

  if who is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  select coalesce(array_agg(distinct ttp.tee_time_id), '{}') into affected
    from tee_time_players ttp
    join rounds r on r.id = ttp.round_id
   where ttp.player_id = in_profile_id
     and r.status <> 'final';

  update scores set entered_by = auth.uid() where entered_by = in_profile_id;
  update events set created_by = auth.uid() where created_by = in_profile_id;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'delete', 'player', in_profile_id::text,
          jsonb_build_object('name', who,
                             'open_groups', coalesce(array_length(affected, 1), 0)));

  delete from auth.users where id = in_profile_id;
  delete from profiles where id = in_profile_id;

  foreach t in array affected loop
    perform rebuild_scoring_ring(t);
  end loop;
end;
$function$;

-- owner_merge_players: The platform admin's, like deleting. The kept account takes every club and league the other was in, with the higher role and the more settled status where both were in the same one.
CREATE OR REPLACE FUNCTION public.owner_merge_players(in_keep uuid, in_remove uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  kept           profiles%rowtype;
  gone           profiles%rowtype;
  gone_phone     text;
  gone_confirmed timestamptz;
  affected       uuid[];
  t              uuid;
begin
  if not is_platform_admin() then
    raise exception 'Only the league owner can merge players.'
      using errcode = 'insufficient_privilege';
  end if;

  if in_keep is null or in_remove is null or in_keep = in_remove then
    raise exception 'Pick two different players.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from league_owner where profile_id = in_remove)
     or exists (select 1 from platform_admins where profile_id = in_remove) then
    raise exception 'The owner''s account can''t be merged away. Merge the other one into it instead.'
      using errcode = 'check_violation';
  end if;

  select * into kept from profiles where id = in_keep;
  select * into gone from profiles where id = in_remove;

  if kept.id is null or gone.id is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
  end if;

  -- Groups the removed account sits in; their scoring rings are redone below.
  select coalesce(array_agg(distinct tee_time_id), '{}') into affected
    from tee_time_players where player_id = in_remove;

  -- Scores.
  delete from scores s
   where s.player_id = in_remove
     and exists (select 1 from scores k
                  where k.player_id = in_keep and k.round_id = s.round_id and k.hole = s.hole);
  update scores set player_id = in_keep where player_id = in_remove;
  update scores set entered_by = in_keep where entered_by = in_remove;

  delete from cleared_scores c
   where c.player_id = in_remove
     and exists (select 1 from cleared_scores k
                  where k.batch = c.batch and k.player_id = in_keep and k.hole = c.hole);
  update cleared_scores set player_id = in_keep where player_id = in_remove;
  update cleared_scores set entered_by = in_keep where entered_by = in_remove;

  -- Groups: one place per player per week.
  delete from scorer_assignments
   where scored_player_id = in_remove or scorer_player_id = in_remove;
  delete from tee_time_players g
   where g.player_id = in_remove
     and exists (select 1 from tee_time_players k
                  where k.round_id = g.round_id and k.player_id = in_keep);
  update tee_time_players set player_id = in_keep where player_id = in_remove;

  -- Answers and requests: one per player per week or tournament.
  delete from round_rsvps r
   where r.player_id = in_remove
     and exists (select 1 from round_rsvps k where k.round_id = r.round_id and k.player_id = in_keep);
  update round_rsvps set player_id = in_keep where player_id = in_remove;
  update round_rsvps set set_by = in_keep where set_by = in_remove;

  delete from tee_time_requests r
   where r.player_id = in_remove
     and exists (select 1 from tee_time_requests k where k.round_id = r.round_id and k.player_id = in_keep);
  update tee_time_requests set player_id = in_keep where player_id = in_remove;

  delete from tournament_rsvps r
   where r.player_id = in_remove
     and exists (select 1 from tournament_rsvps k
                  where k.tournament_id = r.tournament_id and k.player_id = in_keep);
  update tournament_rsvps set player_id = in_keep where player_id = in_remove;
  update tournament_rsvps set set_by = in_keep where set_by = in_remove;

  delete from tournament_results r
   where r.player_id = in_remove
     and exists (select 1 from tournament_results k
                  where k.tournament_id = r.tournament_id and k.player_id = in_keep);
  update tournament_results set player_id = in_keep where player_id = in_remove;

  -- Things they made.
  update feed_posts    set author_id  = in_keep where author_id  = in_remove;
  update events        set created_by = in_keep where created_by = in_remove;
  update tournaments   set created_by = in_keep where created_by = in_remove;
  update client_errors set user_id    = in_keep where user_id    = in_remove;

  select phone, phone_confirmed_at into gone_phone, gone_confirmed
    from auth.users where id = in_remove;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'merge', 'player', in_keep::text,
          jsonb_build_object('kept', kept.full_name, 'removed', gone.full_name,
                             'removed_id', in_remove));

  -- The login goes, and on_auth_user_deleted takes the profile; a guest has
  -- no login, so its profile is deleted directly.
  insert into club_members as k (club_id, profile_id, role, status,
                                  staff_can_edit_scores, requested_at, decided_at, decided_by)
  select club_id, in_keep, role, status, staff_can_edit_scores, requested_at, decided_at, decided_by
    from club_members where profile_id = in_remove
  on conflict (club_id, profile_id) do update
    set role = case when 'admin' in (k.role, excluded.role) then 'admin'
                    when 'staff' in (k.role, excluded.role) then 'staff'
                    else 'player' end,
        status = case when 'active' in (k.status, excluded.status) then 'active'
                      when 'requested' in (k.status, excluded.status) then 'requested'
                      else 'removed' end,
        staff_can_edit_scores =
          case when 'admin' in (k.role, excluded.role) then false
               else k.staff_can_edit_scores or excluded.staff_can_edit_scores end;

  insert into league_members as k (league_id, profile_id, status,
                                   requested_at, decided_at, decided_by)
  select league_id, in_keep, status, requested_at, decided_at, decided_by
    from league_members where profile_id = in_remove
  on conflict (league_id, profile_id) do update
    set status = case when 'active' in (k.status, excluded.status) then 'active'
                      when 'requested' in (k.status, excluded.status) then 'requested'
                      else 'removed' end;

  delete from auth.users where id = in_remove;
  delete from profiles where id = in_remove;

  if coalesce(gone_phone, '') <> ''
     and exists (select 1 from auth.users where id = in_keep and coalesce(phone, '') = '') then
    update auth.users
       set phone = gone_phone, phone_confirmed_at = gone_confirmed
     where id = in_keep;
  end if;

  -- The kept profile takes whatever it was missing.
  update profiles
     set phone              = coalesce(phone, gone.phone),
         handicap_index     = coalesce(handicap_index, gone.handicap_index),
         preferred_tee      = coalesce(preferred_tee, gone.preferred_tee),
         preferred_tee_time = coalesce(preferred_tee_time, gone.preferred_tee_time),
         is_admin           = is_admin or gone.is_admin
   where id = in_keep;

  foreach t in array affected loop
    perform rebuild_scoring_ring(t);
  end loop;
end;
$function$;

-- owner_audit_log: The audit log and the site's error log span every club, so they are the platform admin's.
CREATE OR REPLACE FUNCTION public.owner_audit_log(in_limit integer DEFAULT 50, in_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_platform_admin() then
    raise exception 'Only the league owner can read the audit log.'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(x.entry order by x.at desc, x.id desc)
      from (
        select a.at,
               a.id,
               jsonb_build_object(
                 'id',       a.id,
                 'at',       a.at,
                 'actor',    coalesce(p.full_name, a.actor_label, 'System'),
                 'action',   a.action,
                 'entity',   a.entity,
                 'entityId', a.entity_id,
                 'detail',   a.detail
               ) as entry
          from audit_log a
          left join profiles p on p.id = a.actor_id
         where in_before is null or a.at < in_before
         order by a.at desc, a.id desc
         limit least(greatest(coalesce(in_limit, 50), 1), 200)
      ) as x
  ), '[]'::jsonb);
end;
$function$;

-- owner_client_errors: The audit log and the site's error log span every club, so they are the platform admin's.
CREATE OR REPLACE FUNCTION public.owner_client_errors(in_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_platform_admin() then
    raise exception 'Only the league owner can read site errors.'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(x.entry order by x.at desc, x.id desc)
      from (
        select e.at,
               e.id,
               jsonb_build_object(
                 'id',        e.id,
                 'at',        e.at,
                 'kind',      e.kind,
                 'message',   e.message,
                 'stack',     e.stack,
                 'path',      e.path,
                 'userAgent', e.user_agent,
                 'digest',    e.digest,
                 'who',       p.full_name
               ) as entry
          from client_errors e
          left join profiles p on p.id = e.user_id
         order by e.at desc, e.id desc
         limit least(greatest(coalesce(in_limit, 50), 1), 200)
      ) as x
  ), '[]'::jsonb);
end;
$function$;

-- owner_clear_client_errors: The audit log and the site's error log span every club, so they are the platform admin's.
CREATE OR REPLACE FUNCTION public.owner_clear_client_errors()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  removed integer;
begin
  if not is_platform_admin() then
    raise exception 'Only the league owner can clear site errors.'
      using errcode = 'insufficient_privilege';
  end if;

  delete from client_errors;
  get diagnostics removed = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear', 'client_errors', 'all',
          jsonb_build_object('removed', removed));

  return removed;
end;
$function$;
