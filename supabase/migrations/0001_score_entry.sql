-- Score entry: groups, rotating scorer assignments, scores.
--
-- Covers only what the SCORE ENTRY spec locks down. Handicaps, formats and
-- multi-round tournaments are deliberately absent -- see spec/01-score-entry.md
-- Q4-Q9. Extension points are marked EXTEND.

-- ---------------------------------------------------------------- profiles

create table profiles (
  id         uuid primary key references auth.users on delete cascade,
  full_name  text not null,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Admin check as a security-definer function so policies stay readable and
-- cannot recurse back through profiles' own RLS.
create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $fn$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$fn$;

-- ------------------------------------------------------------------ rounds

create table rounds (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  played_on  date not null,
  hole_count smallint not null default 18 check (hole_count in (9, 18)),
  status     text not null default 'setup'
             check (status in ('setup', 'live', 'final')),
  created_at timestamptz not null default now()
);
-- EXTEND: course_id, format and handicap settings land here.

-- --------------------------------------------------------------- tee times

-- A tee time is the group; pairings are its membership.
create table tee_times (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid not null references rounds on delete cascade,
  tee_at        timestamptz not null,
  starting_hole smallint not null default 1 check (starting_hole >= 1),
  created_at    timestamptz not null default now(),
  -- Lets membership carry a composite FK, which is what makes the
  -- one-group-per-round rule below a plain unique constraint.
  unique (id, round_id)
);

create table tee_time_players (
  tee_time_id uuid not null,
  round_id    uuid not null,
  player_id   uuid not null references profiles on delete cascade,
  -- Defines the rotation ring; buildRotation() walks players in this order.
  position    smallint not null check (position >= 0),
  primary key (tee_time_id, player_id),
  foreign key (tee_time_id, round_id)
    references tee_times (id, round_id) on delete cascade,
  unique (tee_time_id, position),
  -- A player belongs to exactly one group per round.
  unique (round_id, player_id)
);

-- ------------------------------------------------------ scorer assignments

-- One row per player being scored. The rotation seeds these, but the admin may
-- rewrite them mid-round, so this table -- never the formula -- is the
-- authority on who may enter whose card.
create table scorer_assignments (
  tee_time_id      uuid not null references tee_times on delete cascade,
  scored_player_id uuid not null references profiles on delete cascade,
  scorer_player_id uuid not null references profiles on delete cascade,
  updated_at       timestamptz not null default now(),
  primary key (tee_time_id, scored_player_id),
  -- Nobody scores themselves, however the row got here.
  constraint no_self_scoring check (scorer_player_id <> scored_player_id),
  -- A scorer holds at most one card.
  unique (tee_time_id, scorer_player_id)
);

-- ------------------------------------------------------------------ scores

create table scores (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references rounds on delete cascade,
  player_id  uuid not null references profiles on delete cascade,
  hole       smallint not null check (hole >= 1),
  strokes    smallint not null check (strokes between 1 and 20),
  -- Kept separate from player_id: assignments move mid-round and the admin can
  -- overwrite, so "who put this number here" must survive a reassignment.
  entered_by uuid not null references profiles,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (round_id, player_id, hole)
);
-- EXTEND: net strokes / stroke allocation join here once handicaps are specified.

create index scores_round_player on scores (round_id, player_id);

-- --------------------------------------------------- sequential hole entry

-- Blocks creating a gap. Corrections to an already-entered hole are UPDATEs and
-- pass through untouched, so a scorer can fix hole 3 while standing on the 7th.
create or replace function enforce_sequential_holes()
returns trigger
language plpgsql
as $fn$
declare
  entered_before int;
begin
  if is_admin() then
    return new;
  end if;

  select count(*) into entered_before
    from scores
   where round_id = new.round_id
     and player_id = new.player_id
     and hole < new.hole;

  if entered_before <> new.hole - 1 then
    raise exception
      'Hole % cannot be entered yet: holes 1-% must be filled in first.',
      new.hole, new.hole - 1
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger scores_sequential
  before insert on scores
  for each row execute function enforce_sequential_holes();

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger scores_touch
  before update on scores
  for each row execute function touch_updated_at();

-- -------------------------------------------------------------------- RLS

alter table profiles           enable row level security;
alter table rounds             enable row level security;
alter table tee_times          enable row level security;
alter table tee_time_players   enable row level security;
alter table scorer_assignments enable row level security;
alter table scores             enable row level security;

-- Everyone signed in sees the field, the schedule and the pairings; only the
-- admin edits them.
create policy read_profiles on profiles for select to authenticated using (true);
create policy admin_profiles on profiles for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_rounds on rounds for select to authenticated using (true);
create policy admin_rounds on rounds for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_tee_times on tee_times for select to authenticated using (true);
create policy admin_tee_times on tee_times for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_pairings on tee_time_players for select to authenticated using (true);
create policy admin_pairings on tee_time_players for all to authenticated
  using (is_admin()) with check (is_admin());

-- Players can see who is scoring whom; only the admin rewires it.
create policy read_assignments on scorer_assignments for select to authenticated using (true);
create policy admin_assignments on scorer_assignments for all to authenticated
  using (is_admin()) with check (is_admin());

-- Leaderboard: any signed-in player reads every score in the round.
create policy read_scores on scores for select to authenticated using (true);

-- The core rule, enforced in the database rather than the UI: you may write a
-- score only for the one player you are currently assigned, and never your own.
create or replace function may_score(target_round uuid, target_player uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $fn$
  select target_player <> auth.uid()
     and exists (
       select 1
         from scorer_assignments sa
         join tee_times tt on tt.id = sa.tee_time_id
        where tt.round_id = target_round
          and sa.scorer_player_id = auth.uid()
          and sa.scored_player_id = target_player
     );
$fn$;

create policy scorer_inserts on scores for insert to authenticated
  with check (
    entered_by = auth.uid()
    and (is_admin() or may_score(round_id, player_id))
  );

create policy scorer_updates on scores for update to authenticated
  using (is_admin() or may_score(round_id, player_id))
  with check (
    entered_by = auth.uid()
    and (is_admin() or may_score(round_id, player_id))
  );

create policy admin_deletes_scores on scores for delete to authenticated
  using (is_admin());

-- --------------------------------------------------------------- realtime

alter publication supabase_realtime add table scores;
alter publication supabase_realtime add table scorer_assignments;
