/**
 * Scoring formats.
 *
 * One field on the round or event drives everything downstream: how many
 * players a team holds, whether scores are entered per team or per player, and
 * how a team's hole score is derived. Nothing else should branch on format.
 */

export type FormatId =
  | "solo"
  | "scramble_2"
  | "best_ball_2"
  | "scramble_3"
  | "best_ball_3"
  | "scramble_4"
  | "best_ball_4";

/** How scores are gathered and combined. */
export type FormatKind = "solo" | "scramble" | "best_ball";

export type FormatSpec = {
  id: FormatId;
  label: string;
  /** One line explaining it, for the picker cards. */
  blurb: string;
  kind: FormatKind;
  /** Players per team. Solo is 1: every player is their own team. */
  teamSize: number;
  /**
   * Who enters a score on each hole. A scramble team plays one ball, so the
   * team posts once; best ball needs every card.
   */
  entry: "team" | "player";
};

export const FORMATS: readonly FormatSpec[] = [
  {
    id: "solo",
    label: "Solo",
    blurb: "Individual stroke play. Everyone for themselves.",
    kind: "solo",
    teamSize: 1,
    entry: "player",
  },
  {
    id: "scramble_2",
    label: "2-man scramble",
    blurb: "Both hit, play the best ball, one score per hole.",
    kind: "scramble",
    teamSize: 2,
    entry: "team",
  },
  {
    id: "best_ball_2",
    label: "2-man best ball",
    blurb: "Everyone plays their own ball; the lower score counts.",
    kind: "best_ball",
    teamSize: 2,
    entry: "player",
  },
  {
    id: "scramble_3",
    label: "3-man scramble",
    blurb: "Three players, one ball, one score per hole.",
    kind: "scramble",
    teamSize: 3,
    entry: "team",
  },
  {
    id: "best_ball_3",
    label: "3-man best ball",
    blurb: "Three own balls; the lowest of the three counts.",
    kind: "best_ball",
    teamSize: 3,
    entry: "player",
  },
  {
    id: "scramble_4",
    label: "4-man scramble",
    blurb: "Four players, one ball, one score per hole.",
    kind: "scramble",
    teamSize: 4,
    entry: "team",
  },
  {
    id: "best_ball_4",
    label: "4-man best ball",
    blurb: "Four own balls; the lowest of the four counts.",
    kind: "best_ball",
    teamSize: 4,
    entry: "player",
  },
];

const BY_ID = new Map(FORMATS.map((f) => [f.id, f]));

export function getFormat(id: FormatId): FormatSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error(`Unknown format: ${id}`);

  return spec;
}

export function isFormatId(value: string): value is FormatId {
  return BY_ID.has(value as FormatId);
}

/** Team size the format requires. Team creation must enforce this. */
export function teamSize(id: FormatId): number {
  return getFormat(id).teamSize;
}

export function isTeamFormat(id: FormatId): boolean {
  return getFormat(id).kind !== "solo";
}

// ------------------------------------------------------------------ scoring

/** A score as entered: by a player, or by a team in a scramble. */
export type Entry = {
  /** Team the score belongs to. In solo, each player is their own team. */
  teamId: string;
  /** Null for a scramble, where the team posts one score for all of them. */
  playerId: string | null;
  hole: number;
  strokes: number;
};

export type TeamHole = {
  hole: number;
  /** The team's score, or null while the hole is still incomplete. */
  strokes: number | null;
  /**
   * Which players' cards produced the team score. Empty for a scramble (there
   * is only one ball), one id for best ball, more when the low is tied.
   */
  contributors: string[];
  /** Best ball only: how many of the team have posted this hole so far. */
  posted: number;
};

/**
 * Reduce raw entries to one score per hole for a team.
 *
 * A best ball hole stays incomplete until every player on the team has posted
 * it. Taking the low of whoever has finished would flatter a team whose good
 * player holed out first and then worsen their score as the rest came in —
 * a leaderboard that moves backwards is worse than one that waits.
 */
export function teamHoles(
  format: FormatId,
  entries: readonly Entry[],
  teamId: string,
  members: readonly string[],
  holeCount: number,
): TeamHole[] {
  const spec = getFormat(format);
  const mine = entries.filter((e) => e.teamId === teamId);

  return Array.from({ length: holeCount }, (_, i) => {
    const hole = i + 1;
    const onHole = mine.filter((e) => e.hole === hole);

    if (spec.entry === "team") {
      // Exactly one score is expected; if several arrived, the lowest is the
      // one the team played.
      const strokes = onHole.length
        ? Math.min(...onHole.map((e) => e.strokes))
        : null;

      return { hole, strokes, contributors: [], posted: onHole.length };
    }

    const byPlayer = new Map<string, number>();
    for (const entry of onHole) {
      if (entry.playerId) byPlayer.set(entry.playerId, entry.strokes);
    }

    const posted = members.filter((id) => byPlayer.has(id)).length;
    const complete = posted === members.length && members.length > 0;

    if (!complete) return { hole, strokes: null, contributors: [], posted };

    const low = Math.min(...members.map((id) => byPlayer.get(id)!));

    return {
      hole,
      strokes: low,
      contributors: members.filter((id) => byPlayer.get(id) === low),
      posted,
    };
  });
}

export type TeamStanding = {
  teamId: string;
  /** Strokes over the holes completed. */
  strokes: number;
  /** Holes completed — not holes started. */
  thru: number;
  /** Null when the course has no par data. */
  toPar: number | null;
  position: number;
};

/**
 * Standings for team formats. Mirrors the individual leaderboard's rules so a
 * scramble and a solo round rank the same way.
 */
export function buildTeamStandings(
  format: FormatId,
  entries: readonly Entry[],
  teams: readonly { id: string; memberIds: string[] }[],
  holeCount: number,
  pars?: Readonly<Record<number, number>>,
): TeamStanding[] {
  const standings = teams.map((team) => {
    const holes = teamHoles(format, entries, team.id, team.memberIds, holeCount);
    const played = holes.filter((h) => h.strokes !== null);

    const strokes = played.reduce((sum, h) => sum + h.strokes!, 0);
    const par = played.reduce((sum, h) => sum + (pars?.[h.hole] ?? 0), 0);

    return {
      teamId: team.id,
      strokes,
      thru: played.length,
      toPar: pars && played.length > 0 ? strokes - par : null,
      position: 0,
    };
  });

  standings.sort(compare);
  assignPositions(standings);

  return standings;
}

function compare(a: TeamStanding, b: TeamStanding): number {
  // A team that hasn't teed off never outranks one that has.
  if ((a.thru === 0) !== (b.thru === 0)) return a.thru === 0 ? 1 : -1;

  if (a.toPar !== null && b.toPar !== null) {
    if (a.toPar !== b.toPar) return a.toPar - b.toPar;
    if (a.thru !== b.thru) return b.thru - a.thru;
  } else if (a.strokes !== b.strokes) {
    return a.strokes - b.strokes;
  }

  return a.teamId.localeCompare(b.teamId);
}

function assignPositions(standings: TeamStanding[]): void {
  standings.forEach((entry, i) => {
    const previous = standings[i - 1];
    const tied =
      previous !== undefined &&
      previous.thru === entry.thru &&
      (entry.toPar !== null
        ? previous.toPar === entry.toPar
        : previous.strokes === entry.strokes);

    entry.position = tied ? previous.position : i + 1;
  });
}

/** Whether a roster can be split into whole teams of the required size. */
export function validateTeams(
  format: FormatId,
  teams: readonly { memberIds: string[] }[],
): { ok: true } | { ok: false; reason: string } {
  const size = teamSize(format);

  if (!isTeamFormat(format)) {
    const oversized = teams.find((t) => t.memberIds.length !== 1);

    return oversized
      ? { ok: false, reason: "Solo play has one player per team." }
      : { ok: true };
  }

  const wrong = teams.find((t) => t.memberIds.length !== size);
  if (wrong) {
    return {
      ok: false,
      reason: `${getFormat(format).label} needs teams of ${size}; found one with ${wrong.memberIds.length}.`,
    };
  }

  const seen = new Set<string>();
  for (const team of teams) {
    for (const id of team.memberIds) {
      if (seen.has(id)) {
        return { ok: false, reason: "A player appears on more than one team." };
      }
      seen.add(id);
    }
  }

  return { ok: true };
}
