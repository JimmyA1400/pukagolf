/*
  One format system, teams for a league week, and the groundwork for events.

  Additive throughout. Nothing is moved, nothing is rewritten, and every
  existing outing link keeps working: the merge of outings into events is a
  nullable column on the roster, not a migration of rows.

  - A league week can now hold teams and matches of its own, the way an event
    always could. The two keep separate tables on purpose — a week recurs and
    its players are league members, an event is a one-off with an invited
    roster — and one shared TypeScript `Team` covers both, with
    src/lib/formats/parity.test.ts asserting the two read identically.
  - An event roster entry can point at a league profile. A guest with no
    account keeps profile_id null, which is every row that exists today, and
    is also what decides whether a round can reach a handicap record.
  - format_id replaces the scoring_format enum, where the team size was baked
    into the name (scramble_2, best_ball_4). Size is now its own column, so a
    scramble is one format whether two play it or four.
  - A round or an event can be marked played on a simulator. It still counts,
    at a weight the owner sets, because a sim score is a real score played
    somewhere that rolls perfectly.
*/

-- --------------------------------------------------------- a week's teams

create table if not exists round_teams (
  id        uuid primary key default gen_random_uuid(),
  round_id  uuid not null references rounds on delete cascade,
  -- Null until the admin names it; "Team 3" is worked out from position.
  name      text check (name is null or length(btrim(name)) between 1 and 60),
  position  smallint not null default 0,
  /* Ryder Cup will need two sides above the teams. The column is here so the
     later work doesn't have to rewrite the table; nothing reads it yet. */
  side      smallint check (side is null or side in (1, 2)),
  created_at timestamptz not null default now()
);

create index if not exists round_teams_round on round_teams (round_id, position);

create table if not exists round_team_players (
  team_id   uuid not null references round_teams on delete cascade,
  round_id  uuid not null references rounds on delete cascade,
  player_id uuid not null references profiles on delete cascade,
  position  smallint not null default 0,
  primary key (team_id, player_id),
  -- A player is on one side per week.
  unique (round_id, player_id)
);

create index if not exists round_team_players_round on round_team_players (round_id);

create table if not exists round_matches (
  id           uuid primary key default gen_random_uuid(),
  round_id     uuid not null references rounds on delete cascade,
  position     smallint not null default 0,
  home_team_id uuid not null references round_teams on delete cascade,
  -- Null is a bye: an odd field leaves one side without an opponent, and the
  -- sheet says so rather than dropping them.
  away_team_id uuid references round_teams on delete cascade,
  -- Where the match goes off, once tee times are set.
  tee_time_id  uuid references tee_times on delete set null,
  created_at   timestamptz not null default now(),
  check (away_team_id is null or away_team_id <> home_team_id)
);

create index if not exists round_matches_round on round_matches (round_id, position);

alter table round_teams         enable row level security;
alter table round_team_players  enable row level security;
alter table round_matches       enable row level security;

-- Everyone in the league can see who is on which side; only an admin sets it.
drop policy if exists read_round_teams on round_teams;
drop policy if exists admin_round_teams on round_teams;
drop policy if exists read_round_team_players on round_team_players;
drop policy if exists admin_round_team_players on round_team_players;
drop policy if exists read_round_matches on round_matches;
drop policy if exists admin_round_matches on round_matches;

create policy read_round_teams on round_teams for select to authenticated using (true);
create policy admin_round_teams on round_teams for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_round_team_players on round_team_players for select to authenticated using (true);
create policy admin_round_team_players on round_team_players for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_round_matches on round_matches for select to authenticated using (true);
create policy admin_round_matches on round_matches for all to authenticated
  using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------ the week

alter table rounds
  add column if not exists team_size smallint not null default 1
    check (team_size between 1 and 4),
  add column if not exists is_simulator boolean not null default false;

comment on column rounds.team_size is
  'Players per side. 1 is each player for themselves. The format no longer carries the size.';

-- ---------------------------------------------------------------- events

alter table events
  -- An outing is the open kind reached by a share link; a league event is
  -- inside the league, with an invited roster and no anonymous scoring.
  add column if not exists scope text not null default 'outing'
    check (scope in ('outing', 'league')),
  add column if not exists format_id text not null default 'stroke',
  add column if not exists team_size smallint not null default 1
    check (team_size between 1 and 4),
  -- Off by default: an event is its own competition unless the owner says it
  -- counts towards the season.
  add column if not exists counts_for_standings boolean not null default false,
  add column if not exists is_simulator boolean not null default false,
  add column if not exists start_hole smallint not null default 1
    check (start_hole in (1, 10));

/*
  The old enum, translated. Size comes out of the name and into its own
  column; the name itself loses the size. events.format is left in place for
  now so a rollback is a no-op, and goes once nothing reads it.
*/
update events
   set format_id = case format::text
                     when 'solo' then 'stroke'
                     when 'scramble_2' then 'scramble'
                     when 'scramble_3' then 'scramble'
                     when 'scramble_4' then 'scramble'
                     when 'best_ball_2' then 'best_ball'
                     when 'best_ball_3' then 'best_ball'
                     when 'best_ball_4' then 'best_ball'
                     else 'stroke'
                   end,
       team_size = case format::text
                     when 'solo' then 1
                     when 'scramble_2' then 2
                     when 'best_ball_2' then 2
                     when 'scramble_3' then 3
                     when 'best_ball_3' then 3
                     when 'scramble_4' then 4
                     when 'best_ball_4' then 4
                     else 1
                   end
 where format_id = 'stroke' and team_size = 1;

/*
  The roster entry that can be a league member.

  Every row that exists today keeps profile_id null and is untouched: an
  outing is still names typed in by whoever has the link. A league event
  fills it in, and that is what lets the round reach a profile, a handicap
  record and — if the owner turns it on — the season standings.
*/
alter table event_players
  add column if not exists profile_id uuid references profiles on delete set null,
  add column if not exists status rsvp_status;

-- One account can hold one seat in an event.
create unique index if not exists event_players_profile
  on event_players (event_id, profile_id)
  where profile_id is not null;

-- ------------------------------------------------------------ simulator

alter table league_settings
  add column if not exists simulator_weight numeric(4, 3) not null default 0.25
    check (simulator_weight between 0 and 1);

comment on column league_settings.simulator_weight is
  'How much a simulator round moves a handicap index, 0 to 1. Not a WHS rule: a house rule, applied in src/lib/handicap.ts and shown wherever an index is.';
