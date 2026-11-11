-- Per-round settings the admin controls, and the clubhouse feed.
--
-- Both existed only as local state before this, which is why nothing the admin
-- changed and nothing anyone posted survived a refresh.

-- ---------------------------------------------------------------- settings

-- One row per round. Conditions are admin-entered rather than pulled from a
-- forecast: the league knows whether the greens are running fast better than an
-- API does, and it keeps the panel honest without an integration.
create table round_settings (
  round_id    uuid primary key references rounds on delete cascade,
  skins_stake integer not null default 0 check (skins_stake >= 0),
  temp_f      smallint,
  wind        text,
  greens      text,
  sunset      text,
  updated_at  timestamptz not null default now()
);

create trigger round_settings_touch
  before update on round_settings
  for each row execute function touch_updated_at();

alter table round_settings enable row level security;

create policy read_settings on round_settings for select to authenticated
  using (true);

create policy admin_settings on round_settings for all to authenticated
  using (is_admin()) with check (is_admin());

-- A round always has a settings row, so the app never has to handle its absence.
create or replace function create_round_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into round_settings (round_id) values (new.id)
  on conflict (round_id) do nothing;

  return new;
end;
$fn$;

create trigger rounds_get_settings
  after insert on rounds
  for each row execute function create_round_settings();

insert into round_settings (round_id)
select id from rounds on conflict (round_id) do nothing;

-- -------------------------------------------------------------------- feed

create table feed_posts (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references rounds on delete cascade,
  author_id  uuid not null references profiles on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 280),
  created_at timestamptz not null default now()
);

create index feed_posts_round on feed_posts (round_id, created_at desc);

alter table feed_posts enable row level security;

create policy read_feed on feed_posts for select to authenticated using (true);

-- Post as yourself only — the author cannot be spoofed.
create policy write_feed on feed_posts for insert to authenticated
  with check (author_id = auth.uid());

-- Delete your own; the admin can delete anyone's.
create policy delete_feed on feed_posts for delete to authenticated
  using (author_id = auth.uid() or is_admin());

create policy admin_feed on feed_posts for all to authenticated
  using (is_admin()) with check (is_admin());

alter publication supabase_realtime add table round_settings;
alter publication supabase_realtime add table feed_posts;
