/**
 * One shape for a side, whatever table it came out of.
 *
 * A league week keeps its teams in round_teams; an event keeps its in
 * event_teams, where a player may be a name with no account. Those two are
 * not going to become one table — a week recurs and its players are league
 * members, an event is a one-off with an invited roster — but nothing above
 * this file should have to know which it is reading.
 *
 * So: two adapters, one `Team`, and every format rule, warning, score and
 * leaderboard runs on the `Team`. The adapters do storage and nothing else.
 * formats/parity.test.ts runs the same scenarios through both and asserts the
 * results are identical, which is the only thing that keeps them honest.
 */

import type { Score } from "../leaderboard";
import type { FieldPlayer } from "./field";

/** A player on a side. `profileId` is null for an event guest with no account. */
export type TeamPlayer = {
  /** Unique within the competition. A profile id, or an event_players id. */
  id: string;
  profileId: string | null;
  name: string;
  handicapIndex: number | null;
  /** Seat order within the side, which sets the scoring rotation. */
  position: number;
};

export type Team = {
  id: string;
  /** "Team 3", or whatever the admin renamed it to. */
  name: string;
  position: number;
  players: TeamPlayer[];
};

/** A competition is a league week or an event; both hand over the same thing. */
export type TeamSource = {
  kind: "round" | "event";
  /** The round or event id these teams belong to. */
  competitionId: string;
  teams: Team[];
};

// ------------------------------------------------------------------- rounds

/** round_teams + round_team_players, joined to profiles. */
export type RoundTeamRow = {
  id: string;
  name: string | null;
  position: number;
};

export type RoundTeamPlayerRow = {
  team_id: string;
  player_id: string;
  position: number;
};

export type ProfileRow = {
  id: string;
  full_name: string;
  handicap_index: number | null;
};

/**
 * A league week's teams. Every player is a league profile, so `id` and
 * `profileId` are the same value.
 */
export function teamsFromRound({
  roundId,
  teams,
  members,
  profiles,
}: {
  roundId: string;
  teams: readonly RoundTeamRow[];
  members: readonly RoundTeamPlayerRow[];
  profiles: readonly ProfileRow[];
}): TeamSource {
  const byId = new Map(profiles.map((p) => [p.id, p]));

  return {
    kind: "round",
    competitionId: roundId,
    teams: [...teams]
      .sort((a, b) => a.position - b.position)
      .map((team) => ({
        id: team.id,
        name: team.name ?? `Team ${team.position}`,
        position: team.position,
        players: members
          .filter((m) => m.team_id === team.id)
          .sort((a, b) => a.position - b.position)
          .map((m) => ({
            id: m.player_id,
            profileId: m.player_id,
            name: byId.get(m.player_id)?.full_name ?? "Former player",
            handicapIndex: byId.get(m.player_id)?.handicap_index ?? null,
            position: m.position,
          })),
      })),
  };
}

// ------------------------------------------------------------------- events

/** event_teams + event_team_members, joined to event_players. */
export type EventTeamRow = {
  id: string;
  name: string | null;
  position: number;
};

export type EventTeamMemberRow = {
  team_id: string;
  player_id: string;
};

export type EventPlayerRow = {
  id: string;
  name: string;
  position: number;
  /** Set once the roster entry is a league member; null for a guest. */
  profile_id?: string | null;
  handicap_index?: number | null;
};

/**
 * An event's teams. A roster entry may be a league member or a bare name, so
 * `id` is the roster row and `profileId` is set only when there is an account
 * behind it — which is also what decides whether the round reaches a profile.
 */
export function teamsFromEvent({
  eventId,
  teams,
  members,
  players,
}: {
  eventId: string;
  teams: readonly EventTeamRow[];
  members: readonly EventTeamMemberRow[];
  players: readonly EventPlayerRow[];
}): TeamSource {
  const byId = new Map(players.map((p) => [p.id, p]));

  return {
    kind: "event",
    competitionId: eventId,
    teams: [...teams]
      .sort((a, b) => a.position - b.position)
      .map((team) => ({
        id: team.id,
        name: team.name ?? `Team ${team.position}`,
        position: team.position,
        players: members
          .filter((m) => m.team_id === team.id)
          .map((m) => byId.get(m.player_id))
          .filter((p): p is EventPlayerRow => p !== undefined)
          .sort((a, b) => a.position - b.position)
          .map((p) => ({
            id: p.id,
            profileId: p.profile_id ?? null,
            name: p.name,
            handicapIndex: p.handicap_index ?? null,
            position: p.position,
          })),
      })),
  };
}

// ------------------------------------------------------------------ shared

export type EventScoreRow = {
  teamId: string;
  /** Null in a one-ball format: the side posted the hole once, for all of them. */
  playerId: string | null;
  hole: number;
  strokes: number;
};

/**
 * Event scores in the shape the scoring engine reads.
 *
 * The two stores disagree about one-ball formats. A league week writes the
 * side's hole onto every card in the group; an event writes it once, against
 * the side. Rather than teach the engine two storage shapes, the side's score
 * is handed to each of its members here — which is what happened on the
 * course anyway, since all of them played that ball.
 *
 * A row for somebody who is not on the side it names is dropped: it belongs
 * to no hole of this game, and guessing whose it is would be worse.
 */
export function scoresFromEvent(
  scores: readonly EventScoreRow[],
  teams: readonly Team[],
): Score[] {
  const membersOf = new Map(teams.map((t) => [t.id, t.players.map((p) => p.id)]));

  return scores.flatMap((row) => {
    if (row.playerId !== null) {
      return membersOf.get(row.teamId)?.includes(row.playerId)
        ? [{ playerId: row.playerId, hole: row.hole, strokes: row.strokes }]
        : [];
    }

    return (membersOf.get(row.teamId) ?? []).map((playerId) => ({
      playerId,
      hole: row.hole,
      strokes: row.strokes,
    }));
  });
}

/** The field a draft works from, in seat order. */
export function fieldFromTeams(source: TeamSource): FieldPlayer[] {
  return source.teams.flatMap((t) =>
    t.players.map((p) => ({
      id: p.id,
      name: p.name,
      handicapIndex: p.handicapIndex,
    })),
  );
}

/** Which side a player is on, by the id their scores are keyed with. */
export function sideOf(source: TeamSource, playerId: string): Team | null {
  return source.teams.find((t) => t.players.some((p) => p.id === playerId)) ?? null;
}

/**
 * Sides for the scoring engine: the team's id, and the player ids its scores
 * are stored under. In singles each player is a side of one.
 */
export function sidesFromTeams(
  source: TeamSource,
): { id: string; playerIds: string[] }[] {
  return source.teams.map((t) => ({
    id: t.id,
    playerIds: t.players.map((p) => p.id),
  }));
}
