/*
  Team events on a player's profile.

  A side's card is not the player's round — that is why player_event_rounds()
  leaves one-ball formats out of the scoring record — but it is still theirs,
  and "played the club scramble, side finished second" belongs on a profile.

  So it is returned as a result rather than a round: the event, the side they
  were on, and every side's raw scores. The ranking is worked out on the
  client by the same engine that draws the event leaderboard, so a profile
  cannot put a side in a different place from the event itself.

  Own-ball team formats appear here too. Best ball already puts the player's
  own card in their scoring record; this is the separate question of how the
  side did.
*/

create or replace function player_team_events(in_player_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(e order by e.played_on desc)
      from (
        select jsonb_build_object(
                 'eventId',    ev.id,
                 'name',       ev.name,
                 'playedOn',   ev.played_on,
                 'courseName', coalesce(co.name, ev.course_name),
                 'formatId',   ev.format_id,
                 'teamSize',   ev.team_size,
                 'holeCount',  ev.hole_count,
                 'startHole',  ev.start_hole,
                 'isSimulator', ev.is_simulator,
                 'myTeamId',   mine.team_id,
                 'pars', coalesce((
                   select jsonb_object_agg(ch.hole::text, ch.par)
                     from course_holes ch where ch.course_id = ev.course_id
                 ), '{}'::jsonb),
                 'teams', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'id', t.id,
                              'name', t.name,
                              'position', t.position,
                              -- ep2, not ep: the outer join already holds the
                              -- player this is being built for.
                              'members', coalesce((
                                select jsonb_agg(
                                         jsonb_build_object('id', ep2.id, 'name', ep2.name)
                                         order by ep2.position, ep2.name)
                                  from event_team_members m
                                  join event_players ep2 on ep2.id = m.player_id
                                 where m.team_id = t.id
                              ), '[]'::jsonb)
                            ) order by t.position)
                     from event_teams t where t.event_id = ev.id
                 ), '[]'::jsonb),
                 'scores', coalesce((
                   select jsonb_agg(
                            jsonb_build_object('teamId', s.team_id,
                                               'playerId', s.player_id,
                                               'hole', s.hole,
                                               'strokes', s.strokes))
                     from event_scores s where s.event_id = ev.id
                 ), '[]'::jsonb)
               ) as e,
               ev.played_on
          from events ev
          join event_players ep
            on ep.event_id = ev.id and ep.profile_id = in_player_id
          join event_team_members mine on mine.player_id = ep.id
          left join courses co on co.id = ev.course_id
         where ev.scope = 'league'
           -- Sides only. A field of singles has no side result to report.
           and ev.team_size > 1
           and exists (select 1 from event_scores s where s.event_id = ev.id)
      ) as e
  ), '[]'::jsonb);
end;
$fn$;

-- --------------------------------------------------------------- grants

revoke execute on function player_team_events(uuid) from public, anon;
grant execute on function player_team_events(uuid) to authenticated;
