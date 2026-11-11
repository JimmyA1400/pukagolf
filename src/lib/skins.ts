/**
 * Skins with carries.
 *
 * Each hole is worth a fixed stake. The outright low score takes the pot; if
 * two or more players tie the low, nothing is won and the stake carries into
 * the next hole. A hole is only settled once every player in the game has a
 * score on it — until then it is still in progress and its pot is unresolved.
 */

import { roundHoles } from "./holes";
import type { Score } from "./leaderboard";
import { holeResult, type CoursePars } from "./scorecard";

export type SkinStatus = "won" | "carried" | "in_progress";

export type SkinHole = {
  hole: number;
  status: SkinStatus;
  /** Null unless the hole was won outright. */
  winnerId: string | null;
  /** Stake at issue on this hole, including anything carried into it. */
  pot: number;
  /** "birdie", "par"… for the winning score. Null when nobody won. */
  result: string | null;
};

export type SkinsGame = {
  holes: SkinHole[];
  /** Money won per player, keyed by player id. Only settled holes count. */
  winnings: Record<string, number>;
  /** Stake riding on the next undecided hole. */
  carrying: number;
};

export type SkinsOptions = {
  /** Stake per hole. */
  stake: number;
  pars: CoursePars;
  holeCount?: number;
  /** 10 for a back-nine week. */
  startHole?: number;
};

export function playSkins(
  scores: readonly Score[],
  playerIds: readonly string[],
  { stake, pars, holeCount = 18, startHole = 1 }: SkinsOptions,
): SkinsGame {
  const byHole = new Map<number, Map<string, number>>();

  for (const score of scores) {
    // Ignore anyone outside this game — their card is not in the pot.
    if (!playerIds.includes(score.playerId)) continue;

    const hole = byHole.get(score.hole) ?? new Map<string, number>();
    hole.set(score.playerId, score.strokes);
    byHole.set(score.hole, hole);
  }

  const holes: SkinHole[] = [];
  const winnings: Record<string, number> = Object.fromEntries(
    playerIds.map((id) => [id, 0]),
  );
  let carry = 0;

  for (const hole of roundHoles(holeCount, startHole)) {
    const played = byHole.get(hole) ?? new Map<string, number>();
    const pot = carry + stake;

    // Nobody has started this hole: it isn't in progress, it simply hasn't
    // happened. Stop rather than listing the rest of the course as pending.
    if (played.size === 0) break;

    if (played.size < playerIds.length) {
      holes.push({ hole, status: "in_progress", winnerId: null, pot, result: null });
      break;
    }

    const low = Math.min(...played.values());
    const atLow = [...played.entries()].filter(([, strokes]) => strokes === low);

    if (atLow.length === 1) {
      const [winnerId] = atLow[0];

      winnings[winnerId] += pot;
      carry = 0;
      holes.push({
        hole,
        status: "won",
        winnerId,
        pot,
        result: holeResult({ hole, par: pars[hole] ?? 0, strokes: low }),
      });
    } else {
      carry = pot;
      holes.push({ hole, status: "carried", winnerId: null, pot, result: null });
    }
  }

  return { holes, winnings, carrying: carry };
}

/** Total actually paid out so far, i.e. excluding anything still carrying. */
export function totalAwarded(game: SkinsGame): number {
  return Object.values(game.winnings).reduce((sum, amount) => sum + amount, 0);
}
