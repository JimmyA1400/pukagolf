/**
 * Net scoring: gross strokes less the strokes a player's handicap gives them.
 *
 * The leaderboard's own ranking is reused rather than rewritten — every hole
 * is turned into a net score and handed to buildLeaderboard — so net and
 * gross can never disagree about how ties or holes-played are ranked.
 */

import { courseHandicap, nineHoleRating, strokesPerHole } from "./handicap";
import { roundHoles } from "./holes";
import type { Score } from "./leaderboard";
import { resolveTee } from "./tee-preference";

export type RatedTee = {
  tee: string;
  totalYards: number;
  courseRating: number | null;
  slope: number | null;
};

/**
 * The tee a player's round is rated from: the one recorded as played, then the
 * set their preference resolves to on this course, then the longest.
 */
export function playerTee<T extends RatedTee>(
  playedTee: string | null | undefined,
  preference: string | null | undefined,
  options: readonly T[],
): T | null {
  if (options.length === 0) return null;

  if (playedTee) {
    const played = options.find((o) => o.tee.toLowerCase() === playedTee.toLowerCase());
    if (played) return played;
  }

  return (
    resolveTee(preference, options) ??
    [...options].sort((a, b) => b.totalYards - a.totalYards)[0]
  );
}

/**
 * Strokes a player receives for the round, or null when they have no handicap
 * index and so aren't in the net game.
 *
 * WHS course handicap: index × slope/113 + (course rating − par). A tee with
 * no rating or slope falls back to the index itself, rounded — an allowance
 * rather than none.
 *
 * Nine holes, worked out once and rounded once (WHS 9-hole course handicap):
 *
 *   index/2 × slope/113 + (9-hole rating − 9-hole par)
 *
 * A 9-hole course is rated for its nine, so its rating and par are used as
 * they are. Nine holes of an 18-hole course take half the 18-hole rating and
 * par. Which it is shows in the par: a nine's is in the thirties, eighteen's
 * is 54 or more.
 */
export function playingHandicap({
  index,
  tee,
  coursePar,
  holeCount,
}: {
  index: number | null;
  tee: Pick<RatedTee, "courseRating" | "slope"> | null;
  /** Par for the whole course, which is what the rating is set against. */
  coursePar: number;
  holeCount: number;
}): number | null {
  if (index === null) return null;

  const rated = tee?.courseRating != null && tee?.slope != null && coursePar > 0;

  if (holeCount !== 9) {
    return rated ? courseHandicap(index, tee.slope!, tee.courseRating!, coursePar) : Math.round(index);
  }

  if (!rated) return Math.round(index / 2);

  const nine = nineHoleRating(tee.courseRating!, coursePar);

  return Math.round((index / 2) * (tee.slope! / 113) + (nine.rating - nine.par));
}

/**
 * Strokes received on each hole of the round, or null when the course hasn't
 * got a stroke index for every one of them.
 *
 * The indexes are re-ranked across just the holes being played, so a 9-hole
 * round still puts its first stroke on its hardest hole: the front nine's
 * odd indexes 1, 3, 5… become 1, 2, 3….
 */
export function receivedStrokes(
  handicap: number,
  strokeIndexes: Readonly<Record<number, number>>,
  holes: readonly number[],
): Record<number, number> | null {
  if (holes.length === 0) return {};
  if (holes.some((h) => strokeIndexes[h] === undefined)) return null;

  const ranked = [...holes].sort((a, b) => strokeIndexes[a] - strokeIndexes[b]);
  const rerank = Object.fromEntries(ranked.map((hole, i) => [hole, i + 1]));

  return strokesPerHole(handicap, rerank);
}

/**
 * Every score turned net. Players with no allocation (no handicap index) are
 * left out, because a gross score in a net table would beat everyone.
 */
export function toNetScores(
  scores: readonly Score[],
  received: Readonly<Record<string, Readonly<Record<number, number>>>>,
): Score[] {
  return scores.flatMap((score) => {
    const byHole = received[score.playerId];
    if (!byHole) return [];

    return [{ ...score, strokes: score.strokes - (byHole[score.hole] ?? 0) }];
  });
}

export type NetField = {
  /** Strokes each player receives for the round, by player id. */
  handicaps: Record<string, number>;
  /** Strokes received per hole, by player id. */
  received: Record<string, Record<number, number>>;
  /** Players with no handicap index, so not in the net game. */
  withoutIndex: string[];
  /** False when the course lacks stroke indexes and net can't be scored. */
  available: boolean;
};

/** Handicaps and per-hole strokes for everyone in one round. */
export function netField({
  players,
  tees,
  coursePar,
  holeCount,
  strokeIndexes,
  startHole = 1,
}: {
  players: readonly {
    id: string;
    handicapIndex: number | null;
    preferredTee: string | null;
    playedTee?: string | null;
  }[];
  tees: readonly RatedTee[];
  coursePar: number;
  holeCount: number;
  strokeIndexes: Readonly<Record<number, number>>;
  /** 10 for a back-nine week: strokes fall on the back nine's hardest holes. */
  startHole?: number;
}): NetField {
  const holes = roundHoles(holeCount, startHole);
  const handicaps: Record<string, number> = {};
  const received: Record<string, Record<number, number>> = {};
  const withoutIndex: string[] = [];
  let available = true;

  for (const player of players) {
    const tee = playerTee(player.playedTee, player.preferredTee, tees);
    const handicap = playingHandicap({
      index: player.handicapIndex,
      tee,
      coursePar,
      holeCount,
    });

    if (handicap === null) {
      withoutIndex.push(player.id);
      continue;
    }

    const byHole = receivedStrokes(handicap, strokeIndexes, holes);

    if (byHole === null) {
      available = false;
      continue;
    }

    handicaps[player.id] = handicap;
    received[player.id] = byHole;
  }

  return { handicaps, received, withoutIndex, available };
}
