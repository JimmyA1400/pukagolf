/*
  From the testers' third run.

  1. A final week keeps the handicaps it was played on. The standings ranked
     every week net from each player's index as it stood today, so posting a
     new index re-ranked weeks already settled, even in a closed season. Now
     the index each player had is written down when a week is first marked
     final (round_handicaps), and the standings rank that week on it. Weeks
     already final are written down with the index they are ranked on now, so
     nothing moves when this goes in.

  2. Each club has a time zone. Tee times were shown in whatever zone the
     viewer's phone was in, and a week's tee times were set in the zone of
     whoever set them. clubs.time_zone is filled from the club's courses
     (America/New_York where none says), and my_clubs() hands it to the page.

  3. The other leagues on the league page say when and where they play: the
     day and course of the league's latest week, and its first tee time.

  4. Nobody scores a week still being set up. It hasn't been sent out to
     play, so nothing entered then is official. The pro shop sets it Live.

  5. A club admin can read the club's own audit log. Each entry now records
     the club it belongs to (worked out from the week, league, group or event
     it names); an entry whose club can't be told for sure stays out of every
     club's log, so nothing from one club shows in another's.

  Additive: one new table, two columns with defaults, a trigger on scores
  that refuses a write to a Setting-up week, and new or replaced functions.
  No score, player or league row is changed or removed.
*/

-- ------------------------------------------------------------ handicaps on the day

create table if not exists round_handicaps (
  round_id       uuid not null references rounds on delete cascade,
  player_id      uuid not null references profiles on delete cascade,
  handicap_index numeric(3, 1),
  frozen_at      timestamptz not null default now(),
  primary key (round_id, player_id)
);

alter table round_handicaps enable row level security;

drop policy if exists league_reads_round_handicaps on round_handicaps;
create policy league_reads_round_handicaps on round_handicaps for select to authenticated
  using (sees_league(round_league(round_id)));
-- No write policy: written only by freeze_round_handicaps().

-- Everyone in a group that week, and anyone who posted a score in it, at the
-- index they have now. A week marked final again keeps what it first had.
create or replace function freeze_round_handicaps(in_round_id uuid)
returns void
language sql
security definer
set search_path = public
as $fn$
  insert into round_handicaps (round_id, player_id, handicap_index)
  select in_round_id, p.id, p.handicap_index
    from profiles p
   where p.id in (select player_id from tee_time_players where round_id = in_round_id
                  union
                  select player_id from scores where round_id = in_round_id)
  on conflict (round_id, player_id) do nothing;
$fn$;

create or replace function rounds_freeze_on_final()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status = 'final' and (TG_OP = 'INSERT' or old.status is distinct from 'final') then
    perform freeze_round_handicaps(new.id);
  end if;
  return new;
end;
$fn$;

drop trigger if exists freeze_handicaps_on_final on rounds;
create trigger freeze_handicaps_on_final
  after insert or update of status on rounds
  for each row execute function rounds_freeze_on_final();

-- Weeks already final, at the index they are ranked on today.
select freeze_round_handicaps(id) from rounds where status = 'final';

-- ------------------------------------------------------------ the club's time zone

alter table clubs add column if not exists time_zone text not null default 'America/New_York';

-- From the club's own courses, where they say.
update clubs c
   set time_zone = z.timezone
  from (select distinct on (club_id) club_id, timezone
          from courses
         where timezone is not null and club_id is not null
           and timezone in (select name from pg_timezone_names)
         group by club_id, timezone
         order by club_id, count(*) desc) z
 where z.club_id = c.id
   and c.time_zone = 'America/New_York';

-- As in 0049, with the club's time zone.
create or replace function my_clubs()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(x.club order by x.name), '[]'::jsonb)
    from (
      select cl.name,
             jsonb_build_object(
               'id',       cl.id,
               'slug',     cl.slug,
               'name',     cl.name,
               'status',   cl.status,
               'isDemo',   cl.is_demo,
               'timeZone', cl.time_zone,
               'role',     coalesce(club_role(cl.id),
                                    case when is_platform_admin() then 'admin' end),
               'viaPlatform', club_role(cl.id) is null,
               'leagues', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id',    l.id,
                            'slug',  l.slug,
                            'name',  l.name,
                            'plays', exists (
                              select 1 from league_members lm
                               where lm.league_id = l.id
                                 and lm.profile_id = auth.uid()
                                 and lm.status = 'active'))
                          order by l.name)
                   from leagues l
                  where l.club_id = cl.id
                    and l.status = 'active'
                    and sees_league(l.id)
               ), '[]'::jsonb)
             ) as club
        from clubs cl
       where cl.status <> 'closed'
         and (club_role(cl.id) is not null or is_platform_admin())
    ) as x;
$fn$;

-- ------------------------------------------------------------ when the other leagues play

-- As in 0049, with each league's day, first tee time and course: from its
-- latest week, so it says what the league actually does.
create or replace function club_league_choices(in_club_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name,
           'status', (select lm.status from league_members lm
                       where lm.league_id = l.id and lm.profile_id = auth.uid()),
           'day', (select trim(to_char(r.played_on, 'Day'))
                     from rounds r where r.league_id = l.id
                    order by r.played_on desc limit 1),
           'firstTee', (select to_char(lr.first_tee_time, 'HH24:MI')
                          from league_rules lr where lr.league_id = l.id),
           'course', (select c.name
                        from rounds r join courses c on c.id = r.course_id
                       where r.league_id = l.id
                       order by r.played_on desc limit 1))
           order by l.name), '[]'::jsonb)
    from leagues l
   where l.club_id = in_club_id
     and l.status = 'active'
     and exists (select 1 from club_members m
                  where m.club_id = in_club_id and m.profile_id = auth.uid()
                    and m.status = 'active');
$fn$;

-- ------------------------------------------------------------ no scores before a week starts

create or replace function scores_refuse_setup_week()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if (select status from rounds where id = new.round_id) = 'setup' then
    raise exception 'This week is still being set up, so it can''t be scored yet. The pro shop sets it to Live when the groups go out.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

drop trigger if exists refuse_setup_week on scores;
create trigger refuse_setup_week
  before insert or update on scores
  for each row execute function scores_refuse_setup_week();

-- ------------------------------------------------------------ the club's audit log

alter table audit_log add column if not exists club_id uuid references clubs on delete set null;
create index if not exists audit_log_club on audit_log (club_id, at desc);

/*
  The club an entry belongs to, or null when it can't be told for sure.
  First from what the entry names (a week, league, group, event, the club
  itself); then, for an entry about a person or a season, the one club where
  whoever did it is an admin and the person is a member.
*/
create or replace function audit_entry_club(in_actor uuid, in_entity text, in_entity_id text, in_detail jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  found uuid;
  target uuid;
  detail jsonb := coalesce(in_detail, '{}'::jsonb);
begin
  if in_entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    target := in_entity_id::uuid;
  end if;

  if detail ->> 'club_id' ~* '^[0-9a-f-]{36}$' then
    select id into found from clubs where id = (detail ->> 'club_id')::uuid;
  end if;
  if found is null and detail ->> 'league_id' ~* '^[0-9a-f-]{36}$' then
    select club_id into found from leagues where id = (detail ->> 'league_id')::uuid;
  end if;
  if found is null and detail ->> 'round_id' ~* '^[0-9a-f-]{36}$' then
    select l.club_id into found
      from rounds r join leagues l on l.id = r.league_id
     where r.id = (detail ->> 'round_id')::uuid;
  end if;
  if found is null and detail ->> 'event_id' ~* '^[0-9a-f-]{36}$' then
    select club_id into found from events where id = (detail ->> 'event_id')::uuid;
  end if;

  if found is null and target is not null then
    if in_entity = 'club' then
      select id into found from clubs where id = target;
    elsif in_entity in ('league', 'league_rules') then
      select club_id into found from leagues where id = target;
    elsif in_entity = 'round' then
      select l.club_id into found
        from rounds r join leagues l on l.id = r.league_id where r.id = target;
    elsif in_entity in ('group', 'card') then
      select l.club_id into found
        from tee_times t join rounds r on r.id = t.round_id join leagues l on l.id = r.league_id
       where t.id = target;
    elsif in_entity = 'event' then
      select club_id into found from events where id = target;
    end if;
  end if;

  if found is null and in_actor is not null
     and in_entity in ('player', 'handicap', 'season', 'club_member', 'league_member', 'pairing') then
    select case when count(*) = 1 then min(m.club_id::text)::uuid end into found
      from club_members m
     where m.profile_id = in_actor and m.role = 'admin' and m.status = 'active'
       and (in_entity = 'season' or target is null
            or exists (select 1 from club_members them
                        where them.club_id = m.club_id and them.profile_id = target));
  end if;

  return found;
end;
$fn$;

create or replace function audit_log_set_club()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.club_id is null then
    new.club_id := audit_entry_club(new.actor_id, new.entity, new.entity_id, new.detail);
  end if;
  return new;
end;
$fn$;

drop trigger if exists audit_log_club on audit_log;
create trigger audit_log_club
  before insert on audit_log
  for each row execute function audit_log_set_club();

update audit_log
   set club_id = audit_entry_club(actor_id, entity, entity_id, detail)
 where club_id is null;

/*
  The club's audit log, newest first, for its admins. Names the people and
  the week an entry is about, so the page can say it in words.
*/
create or replace function club_audit_log(
  in_club_id uuid,
  in_limit   integer default 50,
  in_before  timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not is_club_admin(in_club_id) then
    raise exception 'Only the club''s admins can read its log.'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(x.entry order by x.at desc, x.id desc)
      from (
        select a.at, a.id,
               jsonb_build_object(
                 'id',       a.id,
                 'at',       a.at,
                 'actor',    coalesce(p.full_name, a.actor_label, 'System'),
                 'action',   a.action,
                 'entity',   a.entity,
                 'entityId', a.entity_id,
                 'detail',   a.detail,
                 'player',   (select full_name from profiles
                               where id::text = coalesce(a.detail ->> 'player_id',
                                                         case when a.entity in ('player', 'handicap', 'club_member', 'league_member')
                                                              then a.entity_id end)),
                 'week',     (select r.name || ' · ' || l.name
                                from rounds r join leagues l on l.id = r.league_id
                               where r.id::text = coalesce(a.detail ->> 'round_id',
                                                           case when a.entity = 'round' then a.entity_id end))
               ) as entry
          from audit_log a
          left join profiles p on p.id = a.actor_id
         where a.club_id = in_club_id
           and (in_before is null or a.at < in_before)
         order by a.at desc, a.id desc
         limit least(greatest(coalesce(in_limit, 50), 1), 200)
      ) as x
  ), '[]'::jsonb);
end;
$fn$;

-- ------------------------------------------------------------ who may call them

revoke execute on function freeze_round_handicaps(uuid) from public, anon, authenticated;
revoke execute on function rounds_freeze_on_final() from public, anon, authenticated;
revoke execute on function scores_refuse_setup_week() from public, anon, authenticated;
revoke execute on function audit_entry_club(uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function audit_log_set_club() from public, anon, authenticated;

revoke execute on function club_audit_log(uuid, integer, timestamptz) from public, anon;
grant execute on function club_audit_log(uuid, integer, timestamptz) to authenticated;
revoke execute on function my_clubs() from public, anon;
grant execute on function my_clubs() to authenticated;
revoke execute on function club_league_choices(uuid) from public, anon;
grant execute on function club_league_choices(uuid) to authenticated;
