/*
  The game a week is played under, and tee times that hold two, three or four.

  - A week is stroke play unless it says otherwise. It can also be Stableford
    (points a hole against par, from a six-number table the owner can change,
    which is what makes it a modified Stableford), or a team game where the
    tee time plays as one side: best ball, or a scramble sharing one ball.
    The league has a default game, and each week can differ from it.
  - Nothing about a score changes. Every game is worked out from the same
    per-player scores when it is shown (src/lib/games.ts), so switching a
    week's game rewrites nothing and switching it back puts everything as it
    was. That is why the week stores its own Stableford table: changing the
    league's should not silently rescore a week that has already been played.
  - A scramble is the one game where a score isn't a player's own. The side
    posts a hole once through enter_team_score, which writes the same number
    onto every card in the group — so cards, skins, net and the standings all
    keep reading plain per-player scores.
  - A tee time now says how many it holds. A threesome is a threesome rather
    than a foursome with an empty seat, and one week can run 4, 4, 3 with the
    admin choosing which is which.

  rounds.format is left alone: it is the events' enum (0007), where a team
  size is baked into the format name. A league side is a tee time, and tee
  times in one week are different sizes, so the league needs its own column.
*/

-- ----------------------------------------------------------------- the game

alter table rounds
  add column if not exists game text not null default 'stroke'
    check (game in ('stroke', 'stableford', 'scramble', 'best_ball')),
  -- Points for 3 under or better, 2 under, 1 under, level, 1 over, and 2 over
  -- or worse. Null in a week that isn't played for points.
  add column if not exists stableford_points smallint[];

alter table league_settings
  add column if not exists default_game text not null default 'stroke'
    check (default_game in ('stroke', 'stableford', 'scramble', 'best_ball')),
  add column if not exists stableford_points smallint[] not null default '{5,4,3,2,1,0}';

-- Existing groups keep the four seats they have always had. An admin marks
-- the ones that are meant to be smaller.
alter table tee_times
  add column if not exists seats smallint not null default 4
    check (seats between 2 and 4);

/* Six numbers, none better than the hole above it. Shared by the two setters. */
create or replace function check_stableford_table(in_points integer[])
returns void
language plpgsql
immutable
set search_path = public
as $fn$
begin
  if coalesce(array_length(in_points, 1), 0) <> 6 then
    raise exception 'Give six numbers: albatross, eagle, birdie, par, bogey, and double bogey or worse.'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from unnest(in_points) as p where p is null or p not between -10 and 20) then
    raise exception 'Points are whole numbers from -10 to 20.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from generate_subscripts(in_points, 1) as i
              where i > 1 and in_points[i] > in_points[i - 1]) then
    raise exception 'A worse hole can''t be worth more than a better one.'
      using errcode = 'check_violation';
  end if;
end;
$fn$;

/*
  Set the week's game.

  Allowed mid-round: the scores are untouched and every game is worked out
  from them when it is shown, so an admin who picked the wrong one on Tuesday
  can put it right on Wednesday without anybody re-entering a card.

  The Stableford table is copied onto the week rather than read from the
  league when the standings are drawn, so changing the league's table later
  leaves played weeks exactly as they were scored.
*/
create or replace function admin_set_week_game(
  in_round_id uuid,
  in_game     text,
  in_points   integer[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  table_used integer[];
begin
  if not is_admin() then
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
$fn$;

-- ------------------------------------------------------------ a side's score

/*
  One score for a whole tee time, in a scramble.

  The side played one ball, so the same number goes on every card in the
  group. Writing it per player rather than inventing a team score keeps every
  other part of the app — a player's own card, their record, the season
  averages — reading exactly what it always read.

  Anyone in the group can post, which is the point of a scramble: whoever is
  holding the phone writes it down. Order is still enforced, by the same
  trigger as any other score.
*/
create or replace function enter_team_score(
  in_round_id    uuid,
  in_tee_time_id uuid,
  in_hole        integer,
  in_strokes     integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
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

  if not is_admin()
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
$fn$;

-- ---------------------------------------------------------------- the seats

create or replace function admin_set_group_seats(in_tee_time_id uuid, in_seats integer)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  taken integer;
begin
  if not is_admin() then
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
$fn$;

/*
  The groups editor, now told how many seats each tee time holds and what the
  week is being played for — in a team game the tee times are the sides, so
  who sits where decides more than the order of play.
*/
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
$fn$;

/* As in 0033, plus the seats the new group holds. */
drop function if exists admin_add_group(uuid, timestamptz);

create or replace function admin_add_group(
  in_round_id uuid,
  in_tee_at   timestamptz,
  in_seats    integer default 4
)
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
$fn$;

/* As in 0033, except that a group is full at its own size, not always four. */
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
  taken   integer;
  room    integer;
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
$fn$;

/*
  As in 0033, except that each group is created holding exactly the number it
  was seated with. Eleven players in threes come out 3, 3, 3, 2 and stay that
  way: nobody is added to a group the split had already closed.

  The groups also start on the week's own first hole rather than always hole
  1, which a back-nine week built from RSVPs had been getting wrong.
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
$fn$;

-- ----------------------------------------------------------------- rules

/* As in 0036, plus the game new weeks start under and its points table. */
drop function if exists owner_set_league_rules(integer[], integer, integer, integer, text, boolean, integer);

create or replace function owner_set_league_rules(
  in_points        integer[],
  in_completion    integer,
  in_drop_worst    integer,
  in_min_weeks     integer,
  in_ranking       text,
  in_guests_score  boolean,
  in_default_stake integer,
  in_default_game  text default null,
  in_stableford    integer[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- Left out, a setting keeps what it had rather than snapping to a default.
  table_used integer[] := coalesce(
    in_stableford,
    (select stableford_points::integer[] from league_settings),
    '{5,4,3,2,1,0}');
  game_used  text := coalesce(
    in_default_game,
    (select default_game from league_settings),
    'stroke');
begin
  if not is_owner() then
    raise exception 'Only the league owner can change the rules.'
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

  update league_settings
     set points_table        = in_points::smallint[],
         completion_point    = in_completion,
         drop_worst          = in_drop_worst,
         min_weeks           = in_min_weeks,
         ranking             = in_ranking,
         guests_score        = coalesce(in_guests_score, false),
         default_skins_stake = in_default_stake,
         default_game        = game_used,
         stableford_points   = table_used::smallint[],
         updated_at          = now();

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'update', 'league_settings', 'rules',
          jsonb_build_object('points', in_points, 'completion', in_completion,
                             'drop_worst', in_drop_worst, 'min_weeks', in_min_weeks,
                             'ranking', in_ranking, 'guests_score', in_guests_score,
                             'default_stake', in_default_stake,
                             'default_game', game_used,
                             'stableford', table_used));
end;
$fn$;

-- ------------------------------------------------------ starting a week

/*
  As in 0037, plus the game.

  Unlike the first hole, which carries over from last week, the game falls
  back to the league's default: a league that plays stroke play and has one
  scramble night shouldn't find itself playing scrambles from then on.
*/
drop function if exists owner_start_new_week(text, date, boolean, uuid, integer, integer);

create or replace function owner_start_new_week(
  in_name        text,
  in_played_on   date,
  in_copy_groups boolean default true,
  in_course_id   uuid default null,
  in_hole_count  integer default null,
  in_start_hole  integer default null,
  in_game        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
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
    from rounds order by played_on desc, created_at desc limit 1;

  if not found then
    raise exception 'There is no week to carry forward yet.'
      using errcode = 'no_data_found';
  end if;

  if in_played_on is null or in_played_on <= prev.played_on then
    raise exception 'The new week has to come after %.', prev.played_on
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from seasons where year = extract(year from in_played_on)::integer) then
    raise exception 'The % season is closed. Reopen it on the admin page to add a week.',
      extract(year from in_played_on)::integer
      using errcode = 'check_violation';
  end if;

  course := coalesce(in_course_id, prev.course_id);

  if in_course_id is not null then
    select hole_count into course_max from courses where id = in_course_id;

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
$fn$;

-- ----------------------------------------------------------- the season

/* As in 0037, plus each week's game and the seats in each group. */
create or replace function league_season(in_year integer default null)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  season integer := coalesce(in_year, extract(year from current_date)::integer);
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
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
        from (select distinct extract(year from played_on)::integer as year from rounds) as y
    ), '[]'::jsonb),

    'closed', (
      select jsonb_build_object(
               'closedAt',     s.closed_at,
               'championId',   s.champion_id,
               'championName', s.champion_name)
        from seasons s
       where s.year = season
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
        ) as w
    ), '[]'::jsonb)
  );
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function check_stableford_table(integer[]) from public, anon, authenticated;
revoke execute on function admin_set_week_game(uuid, text, integer[]) from public, anon;
revoke execute on function enter_team_score(uuid, uuid, integer, integer) from public, anon;
revoke execute on function admin_set_group_seats(uuid, integer) from public, anon;
revoke execute on function admin_add_group(uuid, timestamptz, integer) from public, anon;
revoke execute on function owner_set_league_rules(integer[], integer, integer, integer, text, boolean, integer, text, integer[]) from public, anon;
revoke execute on function owner_start_new_week(text, date, boolean, uuid, integer, integer, text) from public, anon;

grant execute on function admin_set_week_game(uuid, text, integer[]) to authenticated;
grant execute on function enter_team_score(uuid, uuid, integer, integer) to authenticated;
grant execute on function admin_set_group_seats(uuid, integer) to authenticated;
grant execute on function admin_add_group(uuid, timestamptz, integer) to authenticated;
grant execute on function owner_set_league_rules(integer[], integer, integer, integer, text, boolean, integer, text, integer[]) to authenticated;
grant execute on function owner_start_new_week(text, date, boolean, uuid, integer, integer, text) to authenticated;
