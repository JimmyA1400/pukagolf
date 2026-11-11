-- Tournaments: league events with an entry fee, a field limit and results.
--
-- Separate from `rounds` because they carry things a weekly round does not —
-- a fee, a capped field, a description — and separate from `events` because
-- those are the no-account outings. A tournament is played BY league members,
-- so its RSVPs reference profiles.

create table tournaments (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) between 1 and 120),
  description  text,
  played_on    date not null,
  course_id    uuid references courses,
  course_name  text,
  format       scoring_format not null default 'solo',
  entry_fee    numeric(8, 2) not null default 0 check (entry_fee >= 0),
  -- Null means no cap. Zero would mean nobody can enter, which is never
  -- what an organiser intends.
  field_limit  smallint check (field_limit is null or field_limit > 0),
  rsvp_lock_at timestamptz,
  -- Set when results are in; until then the tournament is upcoming.
  completed_at timestamptz,
  /**
   * Money raised for charity by this tournament. Recorded here rather than
   * computed from the fee, because organisers rarely donate the whole entry
   * and Step 8 needs the real figure.
   */
  charity_id   uuid,
  raised       numeric(10, 2) not null default 0 check (raised >= 0),
  created_by   uuid references profiles on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index tournaments_upcoming on tournaments (played_on);

create trigger tournaments_touch before update on tournaments
  for each row execute function touch_updated_at();

create table tournament_rsvps (
  tournament_id uuid not null references tournaments on delete cascade,
  player_id     uuid not null references profiles on delete cascade,
  status        rsvp_status not null default 'undecided',
  set_by        uuid references profiles on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

create index tournament_rsvps_field on tournament_rsvps (tournament_id, status);

create trigger tournament_rsvps_touch before update on tournament_rsvps
  for each row execute function touch_updated_at();

-- Final standings, entered by the admin once played.
create table tournament_results (
  tournament_id uuid not null references tournaments on delete cascade,
  player_id     uuid not null references profiles on delete cascade,
  position      smallint not null check (position > 0),
  gross         smallint check (gross is null or gross between 18 and 200),
  notes         text,
  primary key (tournament_id, player_id)
);

alter table tournaments        enable row level security;
alter table tournament_rsvps   enable row level security;
alter table tournament_results enable row level security;

-- The schedule is public to the league; only the admin edits it.
create policy read_tournaments on tournaments for select to authenticated
  using (true);
create policy admin_tournaments on tournaments for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_results on tournament_results for select to authenticated
  using (true);
create policy admin_results on tournament_results for all to authenticated
  using (is_admin()) with check (is_admin());

-- Everyone sees the field; that is what a field list is for.
create policy read_t_rsvps on tournament_rsvps for select to authenticated
  using (true);

create policy admin_t_rsvps on tournament_rsvps for all to authenticated
  using (is_admin()) with check (is_admin());

/*
  Enter or withdraw from a tournament.

  Three rules, all enforced here rather than in a policy so each refusal
  carries a message: the lock, the field limit, and who may answer for whom.
*/
create or replace function set_tournament_rsvp(
  in_tournament_id uuid,
  in_status        text,
  in_player_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me      uuid := auth.uid();
  target  uuid := coalesce(in_player_id, auth.uid());
  t       tournaments%rowtype;
  entered int;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if target <> me and not is_admin() then
    raise exception 'You can only change your own entry.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into t from tournaments where id = in_tournament_id;
  if t.id is null then
    raise exception 'No such tournament.' using errcode = 'no_data_found';
  end if;

  if t.rsvp_lock_at is not null and t.rsvp_lock_at <= now() and not is_admin() then
    raise exception
      'Entries have closed for this tournament. Contact the admin.'
      using errcode = 'check_violation';
  end if;

  -- Only counted when joining, and only for other people: a player already in
  -- the field must always be able to change their own answer.
  if in_status = 'in' and t.field_limit is not null and not is_admin() then
    select count(*) into entered
      from tournament_rsvps
     where tournament_id = in_tournament_id
       and status = 'in'
       and player_id <> target;

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
$fn$;

revoke execute on function set_tournament_rsvp(uuid, text, uuid) from public;
grant execute on function set_tournament_rsvp(uuid, text, uuid) to authenticated;
