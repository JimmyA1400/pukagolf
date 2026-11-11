-- Anonymous event access, and the audit log triggers.
--
-- Anonymous callers have no table privileges at all. Everything they can do
-- goes through these two security-definer functions, both of which require the
-- share token and scope every read and write to that one event.

-- Resolve a token to an event id, or null. Kept separate so both functions
-- share exactly one definition of "is this token valid".
create or replace function event_id_for_token(token text)
returns uuid
language sql
security definer
stable
set search_path = public
as $fn$
  select id from events where share_token = token;
$fn$;

-- Everything the event page needs, in one round trip.
create or replace function event_state(token text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  target uuid := event_id_for_token(token);
begin
  if target is null then
    raise exception 'No event found for that link.' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'event', (
      select to_jsonb(e) - 'share_token' - 'created_by'
        from events e where e.id = target
    ),
    'players', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.position, p.name)
        from event_players p where p.event_id = target
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', t.id,
                 'name', t.name,
                 'position', t.position,
                 'memberIds', coalesce((
                   select jsonb_agg(m.player_id)
                     from event_team_members m where m.team_id = t.id
                 ), '[]'::jsonb)
               ) order by t.position
             )
        from event_teams t where t.event_id = target
    ), '[]'::jsonb),
    'scores', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'teamId', s.team_id,
                 'playerId', s.player_id,
                 'hole', s.hole,
                 'strokes', s.strokes,
                 'enteredBy', s.entered_by
               ) order by s.hole
             )
        from event_scores s where s.event_id = target
    ), '[]'::jsonb),
    'holes', coalesce((
      select jsonb_agg(
               jsonb_build_object('hole', h.hole, 'par', h.par,
                                  'strokeIndex', h.handicap_index)
               order by h.hole
             )
        from course_holes h
        join events e on e.course_id = h.course_id
       where e.id = target
    ), '[]'::jsonb)
  );
end;
$fn$;

-- Enter or correct one score.
--
-- The format decides the shape: a scramble posts one score for the team with no
-- player, everything else posts per player. Sending the wrong shape is rejected
-- rather than quietly stored, because a scramble row with a player_id would
-- slip past the unique index and let a team post twice on a hole.
create or replace function event_score_submit(
  token       text,
  in_team_id  uuid,
  in_player_id uuid,
  in_hole     smallint,
  in_strokes  smallint,
  in_entered_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target      uuid := event_id_for_token(token);
  event_row   events%rowtype;
  wants_team  boolean;
begin
  if target is null then
    raise exception 'No event found for that link.' using errcode = 'no_data_found';
  end if;

  select * into event_row from events where id = target;

  if in_hole < 1 or in_hole > event_row.hole_count then
    raise exception 'Hole % is outside this event (1-%).',
      in_hole, event_row.hole_count using errcode = 'check_violation';
  end if;

  if in_strokes < 1 or in_strokes > 20 then
    raise exception 'A hole score must be between 1 and 20.'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from event_teams where id = in_team_id and event_id = target
  ) then
    raise exception 'That team is not in this event.' using errcode = 'foreign_key_violation';
  end if;

  wants_team := event_row.format in ('scramble_2', 'scramble_3', 'scramble_4');

  if wants_team and in_player_id is not null then
    raise exception 'A scramble posts one score for the team, not per player.'
      using errcode = 'check_violation';
  end if;

  if not wants_team and in_player_id is null then
    raise exception 'This format needs a score for each player.'
      using errcode = 'check_violation';
  end if;

  if in_player_id is not null and not exists (
    select 1 from event_team_members
     where team_id = in_team_id and player_id = in_player_id
  ) then
    raise exception 'That player is not on that team.'
      using errcode = 'foreign_key_violation';
  end if;

  if wants_team then
    insert into event_scores (event_id, team_id, player_id, hole, strokes, entered_by)
    values (target, in_team_id, null, in_hole, in_strokes, in_entered_by)
    on conflict (event_id, team_id, hole) where player_id is null
    do update set strokes = excluded.strokes, entered_by = excluded.entered_by;
  else
    insert into event_scores (event_id, team_id, player_id, hole, strokes, entered_by)
    values (target, in_team_id, in_player_id, in_hole, in_strokes, in_entered_by)
    on conflict (event_id, player_id, hole) where player_id is not null
    do update set strokes = excluded.strokes, entered_by = excluded.entered_by;
  end if;

  return event_state(token);
end;
$fn$;

-- Anonymous callers may run exactly these two functions and nothing else.
grant execute on function event_state(text) to anon, authenticated;
grant execute on function event_score_submit(text, uuid, uuid, smallint, smallint, text)
  to anon, authenticated;

-- event_id_for_token is an internal helper; exposing it would let a caller
-- confirm whether a guessed token exists without doing anything else.
revoke execute on function event_id_for_token(text) from anon, authenticated;

-- ------------------------------------------------------------ audit log

-- League scores: the actor is the signed-in user.
create or replace function log_score_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (
    auth.uid(),
    lower(TG_OP),
    'score',
    coalesce(new.id, old.id)::text,
    case TG_OP
      when 'INSERT' then jsonb_build_object(
        'player_id', new.player_id, 'hole', new.hole, 'strokes', new.strokes)
      when 'UPDATE' then jsonb_build_object(
        'player_id', new.player_id, 'hole', new.hole,
        'from', old.strokes, 'to', new.strokes)
      else jsonb_build_object(
        'player_id', old.player_id, 'hole', old.hole, 'strokes', old.strokes)
    end
  );

  return coalesce(new, old);
end;
$fn$;

create trigger scores_audited
  after insert or update or delete on scores
  for each row execute function log_score_change();

-- Event scores: there is no account, so the actor is the name they picked.
create or replace function log_event_score_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into audit_log (actor_label, action, entity, entity_id, detail)
  values (
    coalesce(new.entered_by, old.entered_by),
    lower(TG_OP),
    'event_score',
    coalesce(new.id, old.id)::text,
    case TG_OP
      when 'INSERT' then jsonb_build_object(
        'event_id', new.event_id, 'team_id', new.team_id,
        'player_id', new.player_id, 'hole', new.hole, 'strokes', new.strokes)
      when 'UPDATE' then jsonb_build_object(
        'event_id', new.event_id, 'team_id', new.team_id,
        'player_id', new.player_id, 'hole', new.hole,
        'from', old.strokes, 'to', new.strokes)
      else jsonb_build_object(
        'event_id', old.event_id, 'hole', old.hole, 'strokes', old.strokes)
    end
  );

  return coalesce(new, old);
end;
$fn$;

create trigger event_scores_audited
  after insert or update or delete on event_scores
  for each row execute function log_event_score_change();
