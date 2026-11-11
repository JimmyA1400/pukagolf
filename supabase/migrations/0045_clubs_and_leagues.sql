/*
  Clubs, the leagues inside them, and who belongs to each.

  Until now the database held one league and nothing above it: every round,
  season and outing simply belonged to "the league". This adds the two levels
  multi-course needs, and puts everything that exists today inside them:

    clubs           Moose Ridge, or PukaGolf itself. A club has its own
                    players, admins and staff.
    leagues         Several per club: a Saturday league, a Wednesday one.
    club_members    Who belongs to a club, and as what: admin, staff, or
                    player. A request to join is a row waiting on a decision.
    league_members  Who plays in which league. The pro shop places players;
                    a player can only ask.
    platform_admins The PukaGolf owner, above every club.

  Nothing changes for anyone yet. Every existing row goes into one club,
  "PukaGolf", and one league, "Saturday League", and the app keeps reading
  exactly what it read before: is_admin(), is_owner(), league_settings and
  league_owner are untouched, and no policy changes here. Keeping the
  clubs apart is the next migration's work; this one only gives every row an
  address so that one can.

  New columns on existing tables are NOT NULL with a default of the PukaGolf
  club or league, so the functions that create rounds, seasons, courses and
  events today keep working without being rewritten in the same step. Those
  defaults are a bridge: they go once each function passes the club or league
  it means.

  Nothing is deleted or rewritten. The last block counts every table before
  and after and refuses to finish if a single row moved, so applied as one
  transaction a mistake here undoes itself.
*/

-- ------------------------------------------------------------ before

/*
  Every table's row count before anything here runs, compared at the end.
  Not ON COMMIT DROP: run statement by statement, outside one transaction,
  that would drop it before the check could read it.
*/
create temp table migration_0045_before as
select format('%I.%I', table_schema, table_name) as t,
       (xpath('/row/n/text()',
              query_to_xml(format('select count(*) as n from %I.%I',
                                  table_schema, table_name),
                           false, true, '')))[1]::text::bigint as n
  from information_schema.tables
 where table_schema = 'public'
   and table_type = 'BASE TABLE';

-- ------------------------------------------------------------ clubs

create table clubs (
  id         uuid primary key default gen_random_uuid(),
  -- The club's part of the address: pukagolf.com/c/moose-ridge now,
  -- moose-ridge.pukagolf.com once the domain exists.
  slug       text not null unique
             check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 40),
  name       text not null check (length(btrim(name)) between 1 and 80),
  -- Paused: members can look but nothing can be changed. Closed: kept, hidden.
  status     text not null default 'active'
             check (status in ('active', 'paused', 'closed')),
  -- A club shown to a course before it has agreed to anything, labelled so.
  is_demo    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table leagues (
  id         uuid primary key default gen_random_uuid(),
  club_id    uuid not null references clubs on delete restrict,
  slug       text not null
             check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 40),
  name       text not null check (length(btrim(name)) between 1 and 80),
  status     text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (club_id, slug),
  -- Lets a child table hold (club_id, league_id) and have the pair checked,
  -- so a row can never say one club and a league from another.
  unique (id, club_id)
);

-- ------------------------------------------------------------ members

/*
  One row per person per club. A person can belong to several clubs with one
  login, which is why this is a table rather than a column on profiles: their
  handicap and scores stay theirs, whichever club they were played at.

  A request is the same row in status 'requested', so approving it is an
  update, and a removal keeps the row ('removed') so the history of who
  decided what is not lost.
*/
create table club_members (
  club_id               uuid not null references clubs on delete cascade,
  profile_id            uuid not null references profiles on delete cascade,
  role                  text not null default 'player'
                        check (role in ('admin', 'staff', 'player')),
  status                text not null default 'requested'
                        check (status in ('requested', 'active', 'removed')),
  -- The club admin's switch for one staff member: may they fix scores?
  staff_can_edit_scores boolean not null default false,
  requested_at          timestamptz not null default now(),
  decided_at            timestamptz,
  decided_by            uuid references profiles on delete set null,
  primary key (club_id, profile_id),
  constraint score_editing_is_a_staff_setting
    check (not staff_can_edit_scores or role = 'staff')
);

create index club_members_profile on club_members (profile_id);

create table league_members (
  league_id    uuid not null references leagues on delete cascade,
  profile_id   uuid not null references profiles on delete cascade,
  status       text not null default 'requested'
               check (status in ('requested', 'active', 'removed')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references profiles on delete set null,
  primary key (league_id, profile_id)
);

create index league_members_profile on league_members (profile_id);

/*
  Above every club. Its own table, like league_owner, so no policy on
  profiles can ever be what grants it: only SQL run here adds a row.
*/
create table platform_admins (
  profile_id uuid primary key references profiles on delete restrict,
  granted_at timestamptz not null default now()
);

/*
  Locked until the next migration. Row level security with no policies means
  nothing reaches these tables through the API at all, which is right while
  the app doesn't read them and the rules for who may are not written yet.
*/
alter table clubs           enable row level security;
alter table leagues         enable row level security;
alter table club_members    enable row level security;
alter table league_members  enable row level security;
alter table platform_admins enable row level security;

-- ------------------------------------------------------------ PukaGolf

/*
  Fixed ids, so the column defaults below can name them and so the same club
  is "PukaGolf" on the test copy and on live alike.
*/
insert into clubs (id, slug, name)
values ('a0000000-0000-4000-8000-000000000001', 'pukagolf', 'PukaGolf');

insert into leagues (id, club_id, slug, name)
values ('b0000000-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000001',
        'saturday', 'Saturday League');

-- ------------------------------------------------------------ addresses

/*
  Every existing row belongs to PukaGolf. ADD COLUMN with a default fills the
  rows already there in the same statement, so there is no moment where one
  has no club.
*/

alter table rounds
  add column league_id uuid not null
    default 'b0000000-0000-4000-8000-000000000001'
    references leagues on delete restrict;

create index rounds_league on rounds (league_id);

/*
  A season is still keyed by year alone, because owner_close_season and the
  standings look it up that way. The key becomes (league, year) when those
  functions are given the league.
*/
alter table seasons
  add column league_id uuid not null
    default 'b0000000-0000-4000-8000-000000000001'
    references leagues on delete restrict;

/*
  Courses here are layouts a club has set up: par, stroke index, tees. Two
  clubs importing the same course from the search each get their own copy,
  because each can then correct a par without changing the other's.
*/
alter table courses
  add column club_id uuid not null
    default 'a0000000-0000-4000-8000-000000000001'
    references clubs on delete restrict;

create index courses_club on courses (club_id);

/*
  Outings and league events. An outing belongs to a club; a league event
  also to one of its leagues. league_id stays nullable because an outing has
  none, and the pair is checked against leagues so the two can't disagree.
*/
alter table events
  add column club_id uuid not null
    default 'a0000000-0000-4000-8000-000000000001'
    references clubs on delete restrict,
  add column league_id uuid,
  add constraint events_league_in_club
    foreign key (league_id, club_id) references leagues (id, club_id);

update events
   set league_id = 'b0000000-0000-4000-8000-000000000001'
 where scope = 'league';

create index events_club on events (club_id);

alter table tournaments
  add column club_id uuid not null
    default 'a0000000-0000-4000-8000-000000000001'
    references clubs on delete restrict;

alter table charities
  add column club_id uuid not null
    default 'a0000000-0000-4000-8000-000000000001'
    references clubs on delete restrict;

-- ------------------------------------------------------------ who's who

/*
  Everyone with a profile today is in PukaGolf and in its Saturday League.
  Guests too: they are names the admin added to play a week, and they stay in
  the league that week was played in.

  Today's admins become PukaGolf's admins, which is the power they have now.
  The owner is an admin of PukaGolf and also the platform admin, above every
  club.
*/
insert into club_members (club_id, profile_id, role, status, requested_at, decided_at)
select 'a0000000-0000-4000-8000-000000000001',
       p.id,
       case
         when p.is_admin or exists (select 1 from league_owner o where o.profile_id = p.id)
           then 'admin'
         else 'player'
       end,
       'active',
       p.created_at,
       p.created_at
  from profiles p;

insert into league_members (league_id, profile_id, status, requested_at, decided_at)
select 'b0000000-0000-4000-8000-000000000001', p.id, 'active', p.created_at, p.created_at
  from profiles p;

insert into platform_admins (profile_id)
select profile_id from league_owner;

-- ------------------------------------------------------------ check

do $check$
declare
  moved      text;
  profiles_n bigint;
  admins_n   bigint;
begin
  -- No existing table gained or lost a row.
  select string_agg(format('%s (%s -> %s)', b.t, b.n, a.n), ', ')
    into moved
    from migration_0045_before b
    join lateral (
      select (xpath('/row/n/text()',
                    query_to_xml(format('select count(*) as n from %s', b.t),
                                 false, true, '')))[1]::text::bigint as n
    ) a on true
   where a.n <> b.n;

  if moved is not null then
    raise exception 'Rows changed in existing tables: %. Nothing was applied.', moved;
  end if;

  select count(*) into profiles_n from profiles;

  if (select count(*) from club_members
       where club_id = 'a0000000-0000-4000-8000-000000000001'
         and status = 'active') <> profiles_n then
    raise exception 'Not every profile became a PukaGolf member. Nothing was applied.';
  end if;

  if (select count(*) from league_members
       where league_id = 'b0000000-0000-4000-8000-000000000001'
         and status = 'active') <> profiles_n then
    raise exception 'Not every profile joined the Saturday League. Nothing was applied.';
  end if;

  select count(*) into admins_n
    from profiles p
   where p.is_admin
      or exists (select 1 from league_owner o where o.profile_id = p.id);

  if (select count(*) from club_members where role = 'admin') <> admins_n then
    raise exception 'PukaGolf''s admins don''t match today''s. Nothing was applied.';
  end if;

  if (select count(*) from platform_admins) <> (select count(*) from league_owner) then
    raise exception 'The platform admin doesn''t match the league owner. Nothing was applied.';
  end if;

  if exists (select 1 from events where scope = 'league' and league_id is null) then
    raise exception 'A league event was left without its league. Nothing was applied.';
  end if;
end;
$check$;

drop table migration_0045_before;
