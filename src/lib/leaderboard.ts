/**
 * Gross stroke play leaderboard.
 *
 * No handicaps, no net, no team formats — a score belongs to one player and the
 * total is a plain sum. See spec/decisions.md Q5/Q6.
 */

export type Score = {
  playerId: string;
  hole: number;
  strokes: number;
};

export type LeaderboardEntry = {
  playerId: string;
  /** Gross strokes over the holes entered so far. */
  strokes: number;
  /** Holes completed. The sequential-entry rule makes this a count, not a max. */
  thru: number;
  /**
   * Strokes relative to par over the holes played. Null when the round has no
   * par data — see the note on `pars` in buildLeaderboard.
   */
  toPar: number | null;
  /** Competition ranking: ties share a position and consume the slots below. */
  position: number;
};

export type LeaderboardOptions = {
  /**
   * Par for each hole, keyed by hole number.
   *
   * Without it, mid-round standings are not comparable between players: a
   * player thru 9 with 40 strokes is beating a player thru 18 with 78, but a
   * raw total sorts them the other way. With par, both are expressed as
   * strokes over par and the comparison holds at any point in the round.
   *
   * Totals stay correct either way; only the ordering is affected.
   */
  pars?: Readonly<Record<number, number>>;
};

export function buildLeaderboard(
  scores: readonly Score[],
  playerIds: readonly string[],
  options: LeaderboardOptions = {},
): LeaderboardEntry[] {
  const { pars } = options;

  const totals = new Map<string, { strokes: number; thru: number; par: number }>(
    playerIds.map((id) => [id, { strokes: 0, thru: 0, par: 0 }]),
  );

  for (const score of scores) {
    const total = totals.get(score.playerId);
    // A score for someone outside the given field is not this leaderboard's.
    if (!total) continue;

    total.strokes += score.strokes;
    total.thru += 1;
    total.par += pars?.[score.hole] ?? 0;
  }

  const entries = playerIds.map((playerId) => {
    const { strokes, thru, par } = totals.get(playerId)!;

    return {
      playerId,
      strokes,
      thru,
      toPar: pars && thru > 0 ? strokes - par : null,
      position: 0,
    };
  });

  entries.sort(compareEntries);
  assignPositions(entries);

  return entries;
}

function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  // Nobody who has teed off ranks below someone who hasn't.
  if (a.thru === 0 !== (b.thru === 0)) return a.thru === 0 ? 1 : -1;

  if (a.toPar !== null && b.toPar !== null) {
    if (a.toPar !== b.toPar) return a.toPar - b.toPar;
    // Same score to par: whoever has played further has earned it over more holes.
    if (a.thru !== b.thru) return b.thru - a.thru;
  } else if (a.strokes !== b.strokes) {
    return a.strokes - b.strokes;
  }

  return a.playerId.localeCompare(b.playerId);
}

/** Standard competition ranking: 1, T2, T2, 4 — ties consume the slots below. */
function assignPositions(entries: LeaderboardEntry[]): void {
  entries.forEach((entry, i) => {
    const previous = entries[i - 1];
    // Level on the score is a tie whatever the holes played, as on any live
    // board; nobody who hasn't started ties with somebody who has.
    const tiedWithPrevious =
      previous !== undefined &&
      (previous.thru === 0) === (entry.thru === 0) &&
      (entry.toPar !== null
        ? previous.toPar === entry.toPar
        : previous.strokes === entry.strokes && previous.thru === entry.thru);

    entry.position = tiedWithPrevious ? previous.position : i + 1;
  });
}

/**
 * Score to par as golfers read it: "E" level, "+3" over, "-2" under.
 *
 * Returns null when the round has no par data, which callers should render as
 * the raw stroke total instead — there is no honest +/-/E without par.
 */
export function formatToPar(toPar: number | null): string | null {
  if (toPar === null) return null;
  if (toPar === 0) return "E";

  return toPar > 0 ? `+${toPar}` : String(toPar);
}

/** "T3" when the place is shared, "3" when it isn't. */
export function placeLabel(position: number, positions: readonly number[]): string {
  return positions.filter((p) => p === position).length > 1 ? `T${position}` : String(position);
}

/** True when more than one player shares a position, i.e. it renders as "T3". */
export function isTied(
  entries: readonly LeaderboardEntry[],
  position: number,
): boolean {
  return entries.filter((e) => e.position === position).length > 1;
}
