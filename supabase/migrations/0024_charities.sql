-- Charities the league supports, and what each event raised for them.
--
-- Amounts are recorded per tournament and summed, never stored as a season
-- total: a hand-typed total is a number that quietly stops matching the events
-- underneath it, and the first thing anyone asks is which event raised what.

create table charities (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  description text,
  -- A URL rather than an uploaded file: a logo that lives at the charity's own
  -- address stays current when they rebrand.
  logo_url    text check (logo_url is null or logo_url ~ '^https://'),
  website     text check (website is null or website ~ '^https://'),
  active      boolean not null default true,
  position    smallint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger charities_touch before update on charities
  for each row execute function touch_updated_at();

-- The link tournaments already anticipated.
alter table tournaments
  add constraint tournaments_charity_fk
  foreign key (charity_id) references charities on delete set null;

alter table charities enable row level security;

create policy read_charities on charities for select to authenticated
  using (true);
create policy admin_charities on charities for all to authenticated
  using (is_admin()) with check (is_admin());

/*
  Season totals, computed from the tournaments themselves.

  Grouped by calendar year: a golf season is a year here, and anything more
  clever would need a season table nobody has asked for.
*/
create or replace function charity_totals()
returns jsonb
language sql
security definer
stable
set search_path = public
as $fn$
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
    ) as t_row;
$fn$;

-- Supabase's default privileges hand every new function in `public` to anon as
-- well, and revoking from PUBLIC does not take a role-specific grant away, so
-- anon has to be named explicitly.
revoke execute on function charity_totals() from public;
revoke execute on function charity_totals() from anon;
grant execute on function charity_totals() to authenticated;
