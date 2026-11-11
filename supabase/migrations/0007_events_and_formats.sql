-- One-off events, and the scoring format that drives everything downstream.
--
-- Two surfaces now exist. The league (/league) is authenticated: real accounts,
-- season standings, the scorer rotation. An event (/event/[token]) has no
-- accounts at all — a player opens the link, taps their name, and scores.
--
-- SECURITY MODEL FOR EVENTS
-- The share token IS the credential. There is no login, so possession of the
-- link is the entire authorisation: anyone holding it can enter scores for that
-- event, including for other players. That is inherent to "no account, no
-- email" and is the right trade for a one-day outing, but it must be a
-- deliberate choice rather than an accident — so the token is 122 bits of
-- randomness (unguessable, never sequential), and it grants access to exactly
-- one event and nothing else.
--
-- Anonymous users get NO direct table access. Every anonymous read and write
-- goes through a security-definer function that takes the token (0008), so a
-- caller who does not hold a valid token can reach nothing at all.

create type scoring_format as enum (
  'solo',
  'scramble_2',
  'best_ball_2',
  'scramble_3',
  'best_ball_3',
  'scramble_4',
  'best_ball_4'
);

-- The league plays a format too; it has always been solo stroke play.
alter table rounds
  add column format scoring_format not null default 'solo';

-- ------------------------------------------------------------------ events

create table events (
  id            uuid primary key default gen_random_uuid(),
  -- 32 hex characters from a v4 uuid: unguessable, and not derived from
  -- anything about the event.
  share_token   text not null unique
                default replace(gen_random_uuid()::text, '-', ''),
  name          text not null check (length(btrim(name)) between 1 and 120),
  played_on     date not null,
  format        scoring_format not null,
  hole_count    smallint not null default 18 check (hole_count between 1 and 36),
  -- An imported course when one was found, or free text when it wasn't.
  course_id     uuid references courses,
  course_name   text,
  location_name text,
  latitude      double precision,
  longitude     double precision,
  created_by    uuid not null references profiles on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index events_created_by on events (created_by, played_on desc);

create trigger events_touch before update on events
  for each row execute function touch_updated_at();

-- Roster: names only. No accounts, no email, nothing to sign up for.
create table event_players (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references events on delete cascade,
  name     text not null check (length(btrim(name)) between 1 and 60),
  position smallint not null default 0,
  unique (event_id, name)
);

create index event_players_event on event_players (event_id, position);

create table event_teams (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references events on delete cascade,
  name     text,
  position smallint not null default 0
);

create index event_teams_event on event_teams (event_id, position);

create table event_team_members (
  team_id   uuid not null references event_teams on delete cascade,
  player_id uuid not null references event_players on delete cascade,
  primary key (team_id, player_id),
  -- A player belongs to at most one team per event.
  unique (player_id)
);

-- ------------------------------------------------------------ event scores

create table event_scores (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references events on delete cascade,
  team_id    uuid not null references event_teams on delete cascade,
  -- Null in a scramble: the team plays one ball and posts one score.
  player_id  uuid references event_players on delete cascade,
  hole       smallint not null check (hole >= 1),
  strokes    smallint not null check (strokes between 1 and 20),
  -- The name whoever entered it had selected. Not identity — anyone with the
  -- link can score — but enough to answer "who put this here".
  entered_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Best ball and solo: one score per player per hole.
create unique index event_scores_by_player
  on event_scores (event_id, player_id, hole)
  where player_id is not null;

-- Scramble: one score per team per hole.
create unique index event_scores_by_team
  on event_scores (event_id, team_id, hole)
  where player_id is null;

create index event_scores_event on event_scores (event_id, hole);

create trigger event_scores_touch before update on event_scores
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- audit log

-- Every change to a score, on either surface, so nothing can be quietly
-- rewritten. Append-only: no update or delete policy exists for anyone.
create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  -- Set for league changes; null for anonymous event scoring.
  actor_id    uuid references profiles on delete set null,
  -- Free text for anonymous actors, e.g. the name they tapped.
  actor_label text,
  action      text not null,
  entity      text not null,
  entity_id   text not null,
  detail      jsonb
);

create index audit_log_recent on audit_log (at desc);
create index audit_log_entity on audit_log (entity, entity_id, at desc);

-- ------------------------------------------------------------------- RLS

alter table events             enable row level security;
alter table event_players      enable row level security;
alter table event_teams        enable row level security;
alter table event_team_members enable row level security;
alter table event_scores       enable row level security;
alter table audit_log          enable row level security;

-- Signed-in admins manage events through the dashboard. Anonymous access is
-- NOT granted here: it goes through the token functions in 0008, which is what
-- keeps a tokenless caller from reading anything.
create policy admin_events on events for all to authenticated
  using (is_admin()) with check (is_admin());

create policy admin_event_players on event_players for all to authenticated
  using (is_admin()) with check (is_admin());

create policy admin_event_teams on event_teams for all to authenticated
  using (is_admin()) with check (is_admin());

create policy admin_event_team_members on event_team_members for all to authenticated
  using (is_admin()) with check (is_admin());

create policy admin_event_scores on event_scores for all to authenticated
  using (is_admin()) with check (is_admin());

-- The log is readable by admins and written only by triggers (security
-- definer). Nobody gets update or delete — that is the point of a log.
create policy admin_reads_audit on audit_log for select to authenticated
  using (is_admin());

alter publication supabase_realtime add table event_scores;
