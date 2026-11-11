"""
Make the two tester accounts the Golfer and Head Pro agents sign in with.

    python scripts/test-db/make-testers.py

Writes two files, both git-ignored because they hold the testers' passwords:

  scripts/test-db/testers.local.json   who to sign in as, for the agents
  supabase/tests/testers.local.sql     puts them in the TEST project

then load the SQL with apply-to-test.ps1 -Test. Run again for new passwords
and a fresh week; the SQL replaces the testers rather than adding more.

Everything lives in Practice Ridge, a made-up club of its own (every id
begins d), not in Test Valley: the isolation tests load Test Valley inside
a transaction they roll back, so it can't also stay in the database. The
people are fictional and use 555-01xx numbers, which are reserved for
fiction, so no text can reach a real phone.
"""

import json
import os
import secrets
import string

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

CLUB = "d1000000-0000-4000-8000-000000000001"
THURSDAY = "d2000000-0000-4000-8000-000000000001"
SUNDAY = "d2000000-0000-4000-8000-000000000002"
COURSE = "d3000000-0000-4000-8000-000000000001"
WEEK = "d5000000-0000-4000-8000-000000000001"
GROUP_1 = "d6000000-0000-4000-8000-000000000001"
GROUP_2 = "d6000000-0000-4000-8000-000000000002"

TESTERS = {
    "golfer": {
        "id": "d4000000-0000-4000-8000-000000000001",
        "name": "Greg Golfer",
        "phone": "+12395550191",
        "email": "greg.golfer@practice-ridge.test",
        "role": "player",
    },
    "headPro": {
        "id": "d4000000-0000-4000-8000-000000000002",
        "name": "Hank Headpro",
        "phone": "+12395550192",
        "email": "hank.headpro@practice-ridge.test",
        "role": "admin",
    },
}

# People with no login, so there is a field to play against.
OTHERS = [
    ("d4000000-0000-4000-8000-000000000003", "Pat Partner", 14.2),
    ("d4000000-0000-4000-8000-000000000004", "Lou Longhitter", 3.1),
    ("d4000000-0000-4000-8000-000000000005", "Mo Mulligan", 22.5),
    ("d4000000-0000-4000-8000-000000000006", "Sal Sandtrap", 11.0),
]
PAT, LOU, MO, SAL = (o[0] for o in OTHERS)
RITA = ("d4000000-0000-4000-8000-000000000007", "Rita Requester", "+12395550193")


def password() -> str:
    alphabet = string.ascii_letters + string.digits
    return "Pr-" + "".join(secrets.choice(alphabet) for _ in range(16))


def user_sql(t: dict, pw: str) -> str:
    phone = t["phone"].lstrip("+")
    meta = json.dumps({"full_name": t["name"]})
    # Signed in by email: the test project has phone sign-in switched off,
    # and switching it on would mean an SMS provider that can text real phones.
    identity = json.dumps({"sub": t["id"], "email": t["email"], "email_verified": True})
    return f"""
insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password,
                        phone_confirmed_at, raw_app_meta_data,
                        raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '{t["id"]}', 'authenticated',
        'authenticated', '{t["email"]}', '{phone}',
        extensions.crypt('{pw}', extensions.gen_salt('bf')), now(),
        '{{"provider":"email","providers":["email"]}}', '{meta}', now(), now());

-- Sign-in reads these as text and fails on null; older copies lack some.
do $tokens$
declare
  col text;
begin
  foreach col in array array['confirmation_token', 'recovery_token', 'email_change_token_new',
                             'email_change_token_current', 'email_change', 'phone_change',
                             'phone_change_token', 'reauthentication_token'] loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'auth' and table_name = 'users' and column_name = col) then
      execute format('update auth.users set %I = coalesce(%I, $1) where id = $2', col, col)
        using '', '{t["id"]}'::uuid;
    end if;
  end loop;

  -- A confirmed address; older copies call it confirmed_at.
  if exists (select 1 from information_schema.columns
              where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at') then
    update auth.users set email_confirmed_at = now() where id = '{t["id"]}';
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id') then
    insert into auth.identities (id, user_id, provider_id, provider, identity_data,
                                 last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), '{t["id"]}', '{t["id"]}', 'email', '{identity}', now(), now(), now());
  end if;
end;
$tokens$;

-- The new-user trigger makes this; a copy without the trigger needs it made.
insert into profiles (id, full_name, phone, phone_verified)
values ('{t["id"]}', '{t["name"]}', profile_phone('{phone}'), true)
on conflict (id) do update set full_name = excluded.full_name;
"""


def main() -> None:
    creds = {key: {**t, "password": password()} for key, t in TESTERS.items()}
    golfer, pro = creds["golfer"], creds["headPro"]
    people = [golfer["id"], pro["id"], *(o[0] for o in OTHERS), RITA[0]]
    everyone = ", ".join(f"'{p}'" for p in people)

    # The first group is through four holes, so the golfer has a leaderboard to read.
    played = ",\n".join(
        f"  ('{WEEK}', '{player}', {hole}, {strokes}, '{scorer}')"
        for player, scorer, card in [(LOU, SAL, [4, 3, 4, 5]), (MO, LOU, [6, 5, 7, 6]), (SAL, MO, [5, 4, 4, 5])]
        for hole, strokes in enumerate(card, start=1)
    )

    sql = f"""/*
  Practice Ridge and its two testers, in the TEST project only. Generated by
  scripts/test-db/make-testers.py; git-ignored because it holds passwords.
*/
begin;

-- The club, its leagues and course stay from run to run.
insert into clubs (id, slug, name)
values ('{CLUB}', 'practice-ridge', 'Practice Ridge (test club)')
on conflict (id) do nothing;

insert into leagues (id, club_id, slug, name) values
  ('{THURSDAY}', '{CLUB}', 'thursday', 'Practice Ridge Thursday'),
  ('{SUNDAY}', '{CLUB}', 'sunday', 'Practice Ridge Sunday')
on conflict (id) do nothing;

insert into league_rules (league_id)
select id from leagues where club_id = '{CLUB}'
on conflict (league_id) do nothing;

insert into courses (id, club_id, name, hole_count, timezone, location_name)
values ('{COURSE}', '{CLUB}', 'Practice Ridge Course', 9, 'America/New_York', 'Fort Myers, FL')
on conflict (id) do nothing;

-- On the east coast, like the other clubs: tee times read in its time zone.
update courses set timezone = 'America/New_York', location_name = coalesce(location_name, 'Fort Myers, FL')
 where id = '{COURSE}';
do $zone$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'clubs' and column_name = 'time_zone') then
    update clubs set time_zone = 'America/New_York' where id = '{CLUB}';
  end if;
end;
$zone$;

insert into course_holes (course_id, hole, par, handicap_index)
select '{COURSE}', h, (array[4, 4, 3, 5, 4, 4, 3, 4, 5])[h], (array[5, 1, 9, 3, 7, 2, 8, 6, 4])[h]
  from generate_series(1, 9) h
on conflict do nothing;

insert into course_tees (course_id, tee_key, tee_name, tee_color, course_rating, slope, par, yardage)
select '{COURSE}', 'white', 'White', 'White', 35.4, 124, 36, 3120
 where not exists (select 1 from course_tees where course_id = '{COURSE}');

-- Everything the testers did last time goes: the weeks (and with them every
-- score, group and lock), events, seasons, and the people themselves.
delete from rounds where league_id in (select id from leagues where club_id = '{CLUB}');
delete from events where club_id = '{CLUB}';
delete from seasons where league_id in (select id from leagues where club_id = '{CLUB}');
delete from league_members where league_id in (select id from leagues where club_id = '{CLUB}');
delete from club_members where club_id = '{CLUB}';
delete from auth.users where id in ({everyone});
delete from profiles where id in ({everyone});
update league_rules set scoring_mode = 'partner', first_tee_time = '17:00', tee_interval_minutes = 10
 where league_id = '{THURSDAY}';
update league_rules set scoring_mode = 'partner', first_tee_time = '08:00', tee_interval_minutes = 10
 where league_id in (select id from leagues where club_id = '{CLUB}') and league_id <> '{THURSDAY}';
{user_sql(golfer, golfer["password"])}
{user_sql(pro, pro["password"])}
update profiles set handicap_index = 9.8 where id = '{golfer["id"]}';

insert into profiles (id, full_name, handicap_index) values
{",".join(chr(10) + f"  ('{i}', '{n}', {h})" for i, n, h in OTHERS)};

-- Somebody with an account, asking to join, for the head pro to answer.
insert into profiles (id, full_name, phone) values ('{RITA[0]}', '{RITA[1]}', '{RITA[2]}');

insert into club_members (club_id, profile_id, role, status, decided_at) values
  ('{CLUB}', '{pro["id"]}', 'admin', 'active', now()),
  ('{CLUB}', '{golfer["id"]}', 'player', 'active', now()),{",".join(chr(10) + f"  ('{CLUB}', '{o[0]}', 'player', 'active', now())" for o in OTHERS)},
  ('{CLUB}', '{RITA[0]}', 'player', 'requested', null);

insert into league_members (league_id, profile_id, status, decided_at) values
  ('{THURSDAY}', '{golfer["id"]}', 'active', now()),{",".join(chr(10) + f"  ('{THURSDAY}', '{o[0]}', 'active', now())" for o in OTHERS)};

-- The Thursday league's week, live, with two groups: on the latest Thursday
-- (today, if it is one) at the club, teeing off at 5:00 and 5:10 PM there,
-- whatever time the testers run. Group 1 is part way round.
insert into rounds (id, league_id, name, played_on, hole_count, status, course_id)
select '{WEEK}', '{THURSDAY}', 'Practice Ridge Week 1',
       d - ((extract(isodow from d)::integer - 4 + 7) % 7), 9, 'live', '{COURSE}'
  from (select (now() at time zone 'America/New_York')::date as d) today;

insert into tee_times (id, round_id, tee_at, starting_hole)
select g.id, '{WEEK}', ((r.played_on + g.at) at time zone 'America/New_York'), 1
  from rounds r,
       (values ('{GROUP_1}'::uuid, time '17:00'), ('{GROUP_2}'::uuid, time '17:10')) as g(id, at)
 where r.id = '{WEEK}';

insert into tee_time_players (tee_time_id, round_id, player_id, position) values
  ('{GROUP_1}', '{WEEK}', '{LOU}', 0),
  ('{GROUP_1}', '{WEEK}', '{MO}', 1),
  ('{GROUP_1}', '{WEEK}', '{SAL}', 2),
  ('{GROUP_2}', '{WEEK}', '{golfer["id"]}', 0),
  ('{GROUP_2}', '{WEEK}', '{PAT}', 1);

-- Partner Scoring: each keeps the next one's card.
insert into scorer_assignments (tee_time_id, scorer_player_id, scored_player_id) values
  ('{GROUP_1}', '{LOU}', '{MO}'),
  ('{GROUP_1}', '{MO}', '{SAL}'),
  ('{GROUP_1}', '{SAL}', '{LOU}'),
  ('{GROUP_2}', '{golfer["id"]}', '{PAT}'),
  ('{GROUP_2}', '{PAT}', '{golfer["id"]}');

insert into scores (round_id, player_id, hole, strokes, entered_by) values
{played};

commit;

select full_name, phone from profiles where id in ('{golfer["id"]}', '{pro["id"]}') order by full_name;
"""

    with open(os.path.join(ROOT, "supabase", "tests", "testers.local.sql"), "w", newline="\n") as f:
        f.write(sql)

    with open(os.path.join(HERE, "testers.local.json"), "w", newline="\n") as f:
        json.dump(
            {
                key: {
                    "name": c["name"],
                    "phone": c["phone"],
                    "email": c["email"],
                    "password": c["password"],
                    "role": c["role"],
                }
                for key, c in creds.items()
            }
            | {"club": "/c/practice-ridge", "league": "Practice Ridge Thursday"},
            f,
            indent=2,
        )

    print("Wrote supabase/tests/testers.local.sql and scripts/test-db/testers.local.json")


if __name__ == "__main__":
    main()
