/*
  From the testers' eighth run.

  1. "Put back" works on a final week. The cleared scores went back in under
     their first scorer's name, and a final week's lock refused anyone
     writing their own entry, the admin included. It is the same admin
     undoing their own "Clear all", so the scores go in as an admin's change
     with a reason, as "Fix a card" does, and each is logged with it. The
     week keeps the status it has.

  2. "Put back" survives new scores. A score entered after "Clear all" used
     to hide every cleared one. Now the cleared copy stays put back-able for
     its seven days: it refills only the holes that are still empty, a hole
     scored since keeps its new score, and the log says how many were kept.
     The cleared values of those holes stay in the copy for the rest of the
     seven days, so clearing the new score later lets them come back too.

  3. The rules log names what changed. owner_set_league_rules now logs what
     each rule was as well as what it is, so the log can say "Worst weeks
     dropped from 0 to 1", and changing it back says "from 1 to 0" rather
     than reading the same as the first change. A save that changes nothing
     logs nothing.

  Replaced functions only. No score, player or league row is changed.
*/

-- ------------------------------------------------------------ putting cleared scores back

-- As in 0047, on a week of any status, into the holes that are still empty.
create or replace function owner_restore_scores(in_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  batch_id   uuid;
  cleared_on timestamptz;
  restored   integer;
  kept       integer;
  week       rounds%rowtype;
begin
  if not is_club_admin(round_club(in_round_id)) then
    raise exception 'Only the league owner can restore scores.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into week from rounds where id = in_round_id;

  if not found then
    raise exception 'No such week.' using errcode = 'no_data_found';
  end if;

  select batch, cleared_at into batch_id, cleared_on
    from cleared_scores
   where round_id = in_round_id and cleared_at >= now() - interval '7 days'
   order by cleared_at desc
   limit 1;

  if batch_id is null then
    raise exception 'There''s nothing cleared from this week to put back.'
      using errcode = 'no_data_found';
  end if;

  -- Holes scored since the clear keep their new score.
  select count(*) into kept
    from cleared_scores c
   where c.batch = batch_id
     and exists (select 1 from scores s
                  where s.round_id = c.round_id and s.player_id = c.player_id and s.hole = c.hole);

  -- An admin's change with a reason: a locked card or a final week lets it
  -- through, and the card's history says why each hole came back.
  perform set_config('pukagolf.change_reason', 'Put back after “Clear all”', true);

  -- Hole order, so the sequential-entry rule is satisfied as they go in.
  with back as (
    insert into scores (round_id, player_id, hole, strokes, entered_by)
    select c.round_id, c.player_id, c.hole, c.strokes,
           case when exists (select 1 from profiles p where p.id = c.entered_by)
                then c.entered_by else auth.uid() end
      from cleared_scores c
     where c.batch = batch_id
       and exists (select 1 from profiles p where p.id = c.player_id)
       and not exists (select 1 from scores s
                        where s.round_id = c.round_id and s.player_id = c.player_id
                          and s.hole = c.hole)
     order by c.player_id, c.hole
    on conflict (round_id, player_id, hole) do nothing
    returning player_id, hole
  )
  delete from cleared_scores c
   using back b
   where c.batch = batch_id and c.player_id = b.player_id and c.hole = b.hole;

  get diagnostics restored = row_count;

  perform set_config('pukagolf.change_reason', '', true);

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'restore_scores', 'round', in_round_id::text,
          jsonb_build_object('name', week.name, 'restored', restored, 'kept', kept,
                             'batch', batch_id, 'round_id', in_round_id,
                             'cleared_at', cleared_on, 'status', week.status));

  return restored;
end;
$fn$;

-- As in 0053, with the holes scored since, and until when it can be put
-- back. Listed while at least one cleared hole is still empty.
create or replace function owner_restorable_scores()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'roundId',    l.round_id,
             'count',      l.empty,
             'kept',       l.filled,
             'clearedAt',  l.cleared_at,
             'keptUntil',  l.cleared_at + interval '7 days'))
      from (
        select b.round_id, b.cleared_at,
               count(*) filter (where s.hole is null) as empty,
               count(*) filter (where s.hole is not null) as filled
          from (select distinct on (c.round_id) c.round_id, c.batch, c.cleared_at
                  from cleared_scores c
                 where c.cleared_at >= now() - interval '7 days'
                   and is_club_admin(round_club(c.round_id))
                 order by c.round_id, c.cleared_at desc) as b
          join cleared_scores c on c.batch = b.batch
          join profiles p on p.id = c.player_id
          left join scores s
            on s.round_id = c.round_id and s.player_id = c.player_id and s.hole = c.hole
         group by b.round_id, b.cleared_at
      ) as l
     where l.empty > 0
  ), '[]'::jsonb);
end;
$fn$;

-- ------------------------------------------------------------ the rules, from and to

-- As in 0050, with what each rule was, and no line when nothing changed.
create or replace function owner_set_league_rules(
  in_league_id     uuid,
  in_points        integer[],
  in_completion    integer,
  in_drop_worst    integer,
  in_min_weeks     integer,
  in_ranking       text,
  in_guests_score  boolean,
  in_default_stake integer,
  in_default_game  text      default null,
  in_stableford    integer[] default null)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- Left out, a setting keeps what it had rather than snapping to a default.
  table_used integer[] := coalesce(
    in_stableford,
    (select stableford_points::integer[] from league_rules where league_id = in_league_id),
    '{5,4,3,2,1,0}');
  game_used  text := coalesce(
    in_default_game,
    (select default_game from league_rules where league_id = in_league_id),
    'stroke');
  was        jsonb;
  now_is     jsonb;
begin
  if not is_club_admin(league_club(in_league_id)) then
    raise exception 'Only an admin of this club can change the rules.'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(array_length(in_points, 1), 0) not between 1 and 12 then
    raise exception 'Points go to between 1 and 12 places.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from unnest(in_points) as p where p is null or p not between 0 and 100) then
    raise exception 'Points are whole numbers from 0 to 100.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from generate_subscripts(in_points, 1) as i
              where i > 1 and in_points[i] > in_points[i - 1]) then
    raise exception 'Points can''t go up further down the table.' using errcode = 'check_violation';
  end if;

  if in_completion is null or in_completion not between 0 and 10 then
    raise exception 'The finishing point runs from 0 to 10.' using errcode = 'check_violation';
  end if;

  if in_drop_worst is null or in_drop_worst not between 0 and 20 then
    raise exception 'Dropped weeks run from 0 to 20.' using errcode = 'check_violation';
  end if;

  if in_min_weeks is null or in_min_weeks not between 0 and 52 then
    raise exception 'Weeks to qualify run from 0 to 52.' using errcode = 'check_violation';
  end if;

  if in_ranking is null or in_ranking not in ('net', 'gross') then
    raise exception 'Rank by net or gross.' using errcode = 'check_violation';
  end if;

  if in_default_stake is null or in_default_stake not between 0 and 1000 then
    raise exception 'The skins stake runs from 0 to 1000.' using errcode = 'check_violation';
  end if;

  if game_used not in ('stroke', 'stableford', 'scramble', 'best_ball') then
    raise exception 'Pick stroke play, Stableford, best ball or a scramble.'
      using errcode = 'check_violation';
  end if;

  perform check_stableford_table(table_used);

  select jsonb_build_object('points', points_table, 'completion', completion_point,
                            'drop_worst', drop_worst, 'min_weeks', min_weeks,
                            'ranking', ranking, 'guests_score', guests_score,
                            'default_stake', default_skins_stake,
                            'default_game', default_game, 'stableford', stableford_points)
    into was
    from league_rules where league_id = in_league_id;

  update league_rules
     set points_table        = in_points::smallint[],
         completion_point    = in_completion,
         drop_worst          = in_drop_worst,
         min_weeks           = in_min_weeks,
         ranking             = in_ranking,
         guests_score        = coalesce(in_guests_score, false),
         default_skins_stake = in_default_stake,
         default_game        = game_used,
         stableford_points   = table_used::smallint[],
         updated_at          = now()
   where league_id = in_league_id;

  now_is := jsonb_build_object('points', to_jsonb(in_points), 'completion', in_completion,
                               'drop_worst', in_drop_worst, 'min_weeks', in_min_weeks,
                               'ranking', in_ranking, 'guests_score', coalesce(in_guests_score, false),
                               'default_stake', in_default_stake,
                               'default_game', game_used,
                               'stableford', to_jsonb(table_used));

  if was is not distinct from now_is then
    return;
  end if;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_rules', in_league_id::text,
          now_is || case when was is null then '{}'::jsonb
                         else jsonb_build_object('was', was) end);
end;
$fn$;
