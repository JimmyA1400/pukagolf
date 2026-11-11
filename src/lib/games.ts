/**
 * What the week is being played for.
 *
 * A week is stroke play unless the owner picks otherwise. Every other game
 * changes two things and nothing else: who a score belongs to — a player, or
 * the tee time playing as one side — and what ranks them, strokes low first
 * or points high first. Everything downstream reads those two answers rather
 * than branching on the game's name.
 *
 * Handicaps are not applied here. Net is produced the way it always was, by
 * turning each hole into a net score before it arrives (see net.ts), so a net
 * Stableford is simply Stableford counted off net holes.
 */

import { getFormat, isGrossOnly } from "./formats/registry";
import { roundHoles } from "./holes";
import type { Score } from "./leaderboard";

/**
 * The games the weekly league's board can score today.
 *
 * The list itself now comes from src/lib/formats/registry.ts, which the
 * events share, so there is one place a format is described. This file is
 * what the league's own board needs from it: whether the side is a group or a
 * player, whether they share a ball, and what ranks them.
 *
 * Only the four that the board renders are offered. Match play, skins and
 * nines are in the registry and arrive here when their boards do.
 */
export type GameId = "stroke" | "stableford" | "scramble" | "best_ball";

export type GameSpec = {
  id: GameId;
  label: string;
  blurb: string;
  /** The tee time plays as one side rather than each player for themselves. */
  team: boolean;
  /** One ball between them: the side posts each hole once, for all of them. */
  sharedBall: boolean;
  rankedBy: "strokes" | "points";
  /**
   * There is no agreed handicap allowance for a side sharing a ball, so the
   * week is played gross whatever the league's ranking rule says.
   */
  grossOnly: boolean;
};

/** In the order the league picker shows them. */
const LEAGUE_GAMES: readonly GameId[] = ["stroke", "stableford", "best_ball", "scramble"];

function fromRegistry(id: GameId): GameSpec {
  const spec = getFormat(id);

  return {
    id,
    label: spec.label,
    blurb: spec.blurb,
    // A format that can be played singly is not a team game; the ones that
    // cannot — best ball, scramble — are.
    team: !spec.sizes.includes(1),
    sharedBall: spec.ball === "one",
    rankedBy: spec.scoring === "points" ? "points" : "strokes",
    grossOnly: isGrossOnly(spec),
  };
}

export const GAMES: readonly GameSpec[] = LEAGUE_GAMES.map(fromRegistry);

const BY_ID = new Map(GAMES.map((g) => [g.id, g]));

export function isGameId(value: string | null | undefined): value is GameId {
  return BY_ID.has(value as GameId);
}

/** The week's game, falling back to stroke play for anything unrecognised. */
export function getGame(id: string | null | undefined): GameSpec {
  return BY_ID.get(id as GameId) ?? BY_ID.get("stroke")!;
}

// -------------------------------------------------------------- Stableford

/**
 * Points for 3 under or better, 2 under, 1 under, level, 1 over, and 2 over
 * or worse. The standard table; changing its six numbers is what makes a
 * modified Stableford, so both are one game with different values.
 */
export const STABLEFORD = [5, 4, 3, 2, 1, 0] as const;
export const STABLEFORD_STEPS = 6;

/**
 * Points for a hole. Anything better than 3 under scores the top row and
 * anything worse than 2 over the bottom one, which is the point of the game:
 * a hole that has got away costs a fixed amount and no more.
 */
export function stablefordPoints(
  strokes: number,
  par: number,
  table: readonly number[] = STABLEFORD,
): number {
  const step = Math.min(Math.max(strokes - par + 3, 0), STABLEFORD_STEPS - 1);

  return table[step] ?? 0;
}

export type ParsedTable = { ok: true; value: number[] } | { ok: false; reason: string };

/** "5, 4, 3, 2, 1, 0" into a points table, or why not. */
export function parseStablefordTable(input: string): ParsedTable {
  const parts = input.split(/[\s,]+/).filter(Boolean);

  if (parts.length !== STABLEFORD_STEPS) {
    return {
      ok: false,
      reason:
        "Give six numbers: albatross, eagle, birdie, par, bogey, and double bogey or worse.",
    };
  }

  const value = parts.map(Number);

  if (value.some((n) => !Number.isInteger(n) || n < -10 || n > 20)) {
    return { ok: false, reason: "Points are whole numbers from -10 to 20." };
  }

  if (value.some((n, i) => i > 0 && n > value[i - 1])) {
    return { ok: false, reason: "A worse hole can't be worth more than a better one." };
  }

  return { ok: true, value };
}

// ------------------------------------------------------------- the ranking

/** Who a score belongs to: one player, or a tee time playing together. */
export type Side = {
  id: string;
  playerIds: readonly string[];
};

export type SideScore = {
  /** The player's id, or the tee time's in a team game. */
  id: string;
  playerIds: readonly string[];
  /** Strokes over the holes counted so far. */
  strokes: number;
  /** Holes counted — in best ball, the holes the whole side has posted. */
  thru: number;
  toPar: number | null;
  /** Stableford points, or null in a game not played for points. */
  points: number | null;
  position: number;
  /** The side's score on each hole, null where the hole isn't counted yet. */
  holes: Record<number, number | null>;
};

/**
 * The sides a game is played between.
 *
 * In a team game that is each tee time, plus anyone not in one: a player left
 * out of the groups still has a card, and dropping them off the board without
 * a word would be worse than showing them as a side of one.
 */
export function sidesFor(
  game: string | null | undefined,
  playerIds: readonly string[],
  groups: readonly { id: string; playerIds: readonly string[] }[],
): Side[] {
  if (!getGame(game).team) {
    return playerIds.map((id) => ({ id, playerIds: [id] }));
  }

  const seated = new Set(groups.flatMap((g) => g.playerIds));

  return [
    ...groups
      .map((g) => ({
        id: g.id,
        playerIds: g.playerIds.filter((id) => playerIds.includes(id)),
      }))
      .filter((side) => side.playerIds.length > 0),
    ...playerIds.filter((id) => !seated.has(id)).map((id) => ({ id, playerIds: [id] })),
  ];
}

export type GameBoardOptions = {
  game: string | null | undefined;
  sides: readonly Side[];
  scores: readonly Score[];
  /**
   * Par per hole. Without it there is no to-par and no Stableford points —
   * see the note in leaderboard.ts on why raw totals can't be compared
   * mid-round.
   */
  pars?: Readonly<Record<number, number>>;
  holeCount: number;
  /** 10 for a back-nine week. */
  startHole?: number;
  /** The week's Stableford values, when they aren't the standard table. */
  stableford?: readonly number[];
};

/**
 * Every side's score and position under the week's game.
 *
 * For stroke play with a side per player this is the plain leaderboard, and
 * it is built the same way on purpose: one ranking, so the live board and the
 * season standings can never order a week differently.
 */
export function buildGameBoard({
  game,
  sides,
  scores,
  pars,
  holeCount,
  startHole = 1,
  stableford = STABLEFORD,
}: GameBoardOptions): SideScore[] {
  const spec = getGame(game);
  const holes = roundHoles(holeCount, startHole);

  const cards = new Map<string, Map<number, number>>();
  for (const score of scores) {
    const card = cards.get(score.playerId) ?? new Map<number, number>();
    card.set(score.hole, score.strokes);
    cards.set(score.playerId, card);
  }

  const rows: SideScore[] = sides.map((side) => {
    const holeScores: Record<number, number | null> = {};
    let strokes = 0;
    let thru = 0;
    let par = 0;
    let points = 0;

    for (const hole of holes) {
      const posted = side.playerIds
        .map((id) => cards.get(id)?.get(hole))
        .filter((value): value is number => value !== undefined);

      // Best ball waits for the whole side. Taking the low of whoever had
      // finished would flatter a side whose good player holed out first and
      // then walk their score backwards as the rest came in — a board that
      // moves the wrong way is worse than one that waits.
      const counted =
        spec.team && !spec.sharedBall
          ? posted.length === side.playerIds.length && posted.length > 0
          : posted.length > 0;

      const value = counted ? Math.min(...posted) : null;
      holeScores[hole] = value;

      if (value === null) continue;

      strokes += value;
      thru += 1;
      par += pars?.[hole] ?? 0;
      points += stablefordPoints(value, pars?.[hole] ?? 0, stableford);
    }

    return {
      id: side.id,
      playerIds: side.playerIds,
      strokes,
      thru,
      toPar: pars && thru > 0 ? strokes - par : null,
      points: spec.rankedBy === "points" && pars ? points : null,
      position: 0,
      holes: holeScores,
    };
  });

  rows.sort(spec.rankedBy === "points" ? byPoints : byStrokes);
  assignPositions(rows, spec.rankedBy);

  return rows;
}

function byStrokes(a: SideScore, b: SideScore): number {
  // Nobody who has teed off ranks below a side that hasn't.
  if ((a.thru === 0) !== (b.thru === 0)) return a.thru === 0 ? 1 : -1;

  if (a.toPar !== null && b.toPar !== null) {
    if (a.toPar !== b.toPar) return a.toPar - b.toPar;
    // Level with each other: whoever has played further has earned it.
    if (a.thru !== b.thru) return b.thru - a.thru;
  } else if (a.strokes !== b.strokes) {
    return a.strokes - b.strokes;
  }

  return a.id.localeCompare(b.id);
}

function byPoints(a: SideScore, b: SideScore): number {
  if ((a.thru === 0) !== (b.thru === 0)) return a.thru === 0 ? 1 : -1;

  const points = (b.points ?? 0) - (a.points ?? 0);
  if (points !== 0) return points;
  if (a.thru !== b.thru) return b.thru - a.thru;

  return a.id.localeCompare(b.id);
}

/** Standard competition ranking: 1, T2, T2, 4. */
function assignPositions(rows: SideScore[], rankedBy: GameSpec["rankedBy"]): void {
  rows.forEach((row, i) => {
    const previous = rows[i - 1];
    // Level on the score is a tie, however many holes each has played: a
    // live board reads "T1" for -2 thru 9 and -2 thru 4, as golfers expect.
    // The order within the tie still puts whoever has played further first.
    // Nobody who hasn't started ties with somebody who has.
    const tied =
      previous !== undefined &&
      (previous.thru === 0) === (row.thru === 0) &&
      (rankedBy === "points"
        ? previous.points === row.points
        : row.toPar !== null
          ? previous.toPar === row.toPar
          : previous.strokes === row.strokes && previous.thru === row.thru);

    row.position = tied ? previous.position : i + 1;
  });
}

/** The figure a board shows for a side: "+3", "24", or nothing played yet. */
export function formatGameScore(row: SideScore, game: string | null | undefined): string {
  if (row.thru === 0) return "—";

  if (getGame(game).rankedBy === "points") {
    return String(row.points ?? row.strokes);
  }

  if (row.toPar === null) return String(row.strokes);

  return row.toPar === 0 ? "E" : row.toPar > 0 ? `+${row.toPar}` : String(row.toPar);
}
