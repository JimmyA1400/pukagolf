/*
  Groups and tee times for a league week: edited by hand, or built from who
  said they're in.

  Admins could already write these tables directly, but moving one player
  touches two groups and both of their scoring rings, so every edit here is a
  single function that does all of it in one transaction. They are admin
  functions, not owner ones: the original spec gave admins pairings and
  tee times.

  A week can now start empty, in "setup", while players RSVP; building its
  groups from the "in" answers then sets rsvp_lock_at, the existing lock that
  stops players changing their answer once pairings are made, and opens the
  week for scoring.
*/

-- ------------------------------------------------------------- the editor

create or replace function admin_week_groups(in_round_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  week rounds%rowtype;
begin
  if not is_admin() then
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
                   'players', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',       ttp.player_id,
                                'name',     p.full_name,
                                'position', ttp.position,
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

    -- Everyone not in a group this week, with their answer.
    'others', coalesce((
      select jsonb_agg(o.entry order by o.rank, o.name)
        from (
          select p.full_name as name,
                 case r.status when 'in' then 0 when 'undecided' then 2 when 'out' then 3 else 1 end as rank,
                 jsonb_build_object(
                   'id',               p.id,
                   'name',             p.full_name,
                   'rsvp',             r.status,
                   'preferredTeeTime', p.preferred_tee_time
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
                     where not exists (select 1 from round_rsvps r
                                        where r.round_id = week.id and r.player_id = p.id))
    )
  );
end;
$fn$;

create or replace function admin_add_group(in_round_id uuid, in_tee_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  tee uuid;
begin
  if not is_admin() then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from rounds where id = in_round_id) then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  if in_tee_at is null then
    raise exception 'Give the group a tee time.' using errcode = 'check_violation';
  end if;

  insert into tee_times (round_id, tee_at, starting_hole)
  values (in_round_id, in_tee_at, 1)
  returning id into tee;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'group', tee::text,
          jsonb_build_object('round_id', in_round_id, 'tee_at', in_tee_at));

  return tee;
end;
$fn$;

create or replace function admin_set_group_time(in_tee_time_id uuid, in_tee_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_admin() then
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
$fn$;

create or replace function admin_delete_group(in_tee_time_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_admin() then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Only an empty one: deleting a full group would silently drop its players
  -- out of the week.
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
$fn$;

/*
  Put a player in a group, move them to another, or take them out of the week
  (in_tee_time_id null). Both groups get their scoring ring rebuilt: removing a
  tee_time_players row does not touch scorer_assignments, so without this the
  old group would keep a card for someone no longer in it.

  Their scores stay where they are — scores belong to the week and the player,
  not the group — so moving someone mid-round only changes who keeps their card.
*/
create or replace function admin_place_player(
  in_round_id    uuid,
  in_player_id   uuid,
  in_tee_time_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  old_tee uuid;
  seats   integer;
  who     text;
begin
  if not is_admin() then
    raise exception 'Only an admin can edit groups.'
      using errcode = 'insufficient_privilege';
  end if;

  select full_name into who from profiles where id = in_player_id;

  if who is null then
    raise exception 'No such player.' using errcode = 'no_data_found';
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
    select count(*) into seats from tee_time_players where tee_time_id = in_tee_time_id;

    if seats >= 4 then
      raise exception 'That group is full. A tee time holds four.'
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
$fn$;

/*
  Build the week's groups from everyone who said they're in.

  Seated by the tee time they asked for — earliest first, no preference after,
  alphabetically — then split as evenly as possible and never into a group of
  one (src/lib/league-groups.ts is the same arithmetic, for the preview).

  It replaces whatever groups the week has, so it refuses once scores exist;
  moving players one at a time still works then.
*/
create or replace function admin_build_week_from_rsvps(
  in_round_id         uuid,
  in_first_tee        timestamptz,
  in_interval_minutes integer default 10,
  in_group_size       integer default 4
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
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
  if not is_admin() then
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

    insert into tee_times (round_id, tee_at, starting_hole)
    values (in_round_id, in_first_tee + make_interval(mins => g * in_interval_minutes), 1)
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
                             'first_tee', in_first_tee));

  return jsonb_build_object('groups', group_count, 'players', total);
end;
$fn$;

-- ------------------------------------------------------ starting a week

/*
  owner_start_new_week gains a choice: copy this week's groups (as before), or
  start the new week empty in "setup" so players can RSVP and the groups are
  built from their answers. The old two-argument version is dropped rather than
  left beside the new one — an old overload is exactly the drift
  scripts/drift-check.py reports.
*/
drop function if exists owner_start_new_week(text, date);

create or replace function owner_start_new_week(
  in_name        text,
  in_played_on   date,
  in_copy_groups boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  prev      rounds%rowtype;
  new_round uuid;
  shift     interval;
  tt        record;
  new_tee   uuid;
begin
  if not is_owner() then
    raise exception 'Only the league owner can start a new week.'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(in_name, ''))) not between 1 and 120 then
    raise exception 'Give the week a name.' using errcode = 'check_violation';
  end if;

  select * into prev
    from rounds order by played_on desc, created_at desc limit 1;

  if not found then
    raise exception 'There is no week to carry forward yet.'
      using errcode = 'no_data_found';
  end if;

  if in_played_on is null or in_played_on <= prev.played_on then
    raise exception 'The new week has to come after %.', prev.played_on
      using errcode = 'check_violation';
  end if;

  -- rounds_get_settings creates this week's round_settings row.
  insert into rounds (name, played_on, hole_count, status, course_id, format)
  values (btrim(in_name), in_played_on, prev.hole_count,
          case when in_copy_groups then 'live' else 'setup' end,
          prev.course_id, prev.format)
  returning id into new_round;

  if in_copy_groups then
    shift := (in_played_on - prev.played_on) * interval '1 day';

    for tt in
      select id, tee_at, starting_hole
        from tee_times where round_id = prev.id order by tee_at
    loop
      insert into tee_times (round_id, tee_at, starting_hole)
      values (new_round, tt.tee_at + shift, tt.starting_hole)
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
         skins_stake   = os.skins_stake
    from round_settings os
   where ns.round_id = new_round
     and os.round_id = prev.id;

  update rounds set status = 'final' where id = prev.id and status <> 'final';

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'create', 'round', new_round::text,
          jsonb_build_object('name', btrim(in_name), 'played_on', in_played_on,
                             'carried_from', prev.id, 'copied_groups', in_copy_groups));

  return new_round;
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function admin_week_groups(uuid) from public, anon;
revoke execute on function admin_add_group(uuid, timestamptz) from public, anon;
revoke execute on function admin_set_group_time(uuid, timestamptz) from public, anon;
revoke execute on function admin_delete_group(uuid) from public, anon;
revoke execute on function admin_place_player(uuid, uuid, uuid) from public, anon;
revoke execute on function admin_build_week_from_rsvps(uuid, timestamptz, integer, integer) from public, anon;
revoke execute on function owner_start_new_week(text, date, boolean) from public, anon;

grant execute on function admin_week_groups(uuid) to authenticated;
grant execute on function admin_add_group(uuid, timestamptz) to authenticated;
grant execute on function admin_set_group_time(uuid, timestamptz) to authenticated;
grant execute on function admin_delete_group(uuid) to authenticated;
grant execute on function admin_place_player(uuid, uuid, uuid) to authenticated;
grant execute on function admin_build_week_from_rsvps(uuid, timestamptz, integer, integer) to authenticated;
grant execute on function owner_start_new_week(text, date, boolean) to authenticated;
