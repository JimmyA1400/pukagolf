/**
 * World Handicap System calculations.
 *
 * Kept whole and separate so the arithmetic can be checked against the
 * published tables rather than inferred from a component's output.
 *
 * A reminder on signs, which this file inherits from handicap-index.ts: a plus
 * handicap is BETTER than scratch and is negative here. A +1.4 player is -1.4.
 */

/** A round reduced to what the handicap maths needs. */
export type ScoringRecord = {
  /** Adjusted gross score — see `adjustedGross`. */
  adjustedGross: number;
  courseRating: number;
  slope: number;
  /** Most recent first is not assumed; callers pass a date to sort by. */
  playedOn: string;
  /** Played indoors. See SIMULATOR_WEIGHT. */
  simulator?: boolean;
};

/**
 * Score differential: how far a round was from the course's difficulty.
 *
 *   (113 / slope) x (adjusted gross - course rating)
 *
 * 113 is the slope of a course of average difficulty, so the ratio rescales
 * every course onto one comparable axis.
 */
export function differential(
  adjustedGross: number,
  courseRating: number,
  slope: number,
): number {
  if (slope <= 0) {
    throw new Error("Slope must be positive; it scales the whole calculation.");
  }

  return round1((113 / slope) * (adjustedGross - courseRating));
}

/**
 * How many differentials to average, and what to adjust the result by.
 *
 * This is the published WHS table, not an approximation. Below 20 rounds it
 * deliberately flatters nobody: with exactly 3 rounds it takes the single best
 * and then subtracts 2.0, because one good round is weak evidence.
 */
const WHS_TABLE: Record<number, { lowest: number; adjustment: number }> = {
  3: { lowest: 1, adjustment: -2.0 },
  4: { lowest: 1, adjustment: -1.0 },
  5: { lowest: 1, adjustment: 0 },
  6: { lowest: 2, adjustment: -1.0 },
  7: { lowest: 2, adjustment: 0 },
  8: { lowest: 2, adjustment: 0 },
  9: { lowest: 3, adjustment: 0 },
  10: { lowest: 3, adjustment: 0 },
  11: { lowest: 3, adjustment: 0 },
  12: { lowest: 4, adjustment: 0 },
  13: { lowest: 4, adjustment: 0 },
  14: { lowest: 4, adjustment: 0 },
  15: { lowest: 5, adjustment: 0 },
  16: { lowest: 5, adjustment: 0 },
  17: { lowest: 6, adjustment: 0 },
  18: { lowest: 6, adjustment: 0 },
  19: { lowest: 7, adjustment: 0 },
  20: { lowest: 8, adjustment: 0 },
};

/** Minimum rounds before a calculated index means anything. */
export const MIN_ROUNDS_FOR_INDEX = 3;

/** How many recent rounds are considered, however many exist. */
export const SCORING_RECORD_SIZE = 20;

export type HandicapResult =
  | {
      /** Not enough rounds; the self-reported figure stands. */
      status: "provisional";
      index: number | null;
      roundsPosted: number;
      roundsNeeded: number;
      /** Rounds in the record played indoors, for the note under the index. */
      simulatorRounds: number;
    }
  | {
      status: "calculated";
      index: number;
      roundsPosted: number;
      /** How many differentials were averaged. */
      differentialsUsed: number;
      simulatorRounds: number;
      /** What each of those counted for, 0 to 1. See SIMULATOR_WEIGHT. */
      simulatorWeight: number;
    };

/** A round reduced to the one number the index is built from. */
export type DifferentialEntry = {
  differential: number;
  playedOn: string;
  /** Played indoors. Pulled towards the player's outdoor form; see below. */
  simulator?: boolean;
};

/**
 * How much a simulator round moves an index, by default.
 *
 * THIS IS A HOUSE RULE, NOT WHS. Everything else in this file is the
 * published method; weighting is not part of it, and cannot be — WHS takes
 * the lowest 8 of your last 20, and a selection cannot be weighted.
 *
 * So a weight is applied to the differential instead, before the selection:
 * a simulator round is pulled towards what the player shoots outdoors.
 *
 *     effective = anchor + weight x (differential - anchor)
 *
 * At 0.25 a sim round four shots better than a player's outdoor form counts
 * as one shot better. At 1 it counts in full and this file is pure WHS again;
 * at 0 it is left out of the record altogether.
 *
 * The anchor is the player's index from their outdoor rounds only — a
 * disjoint set, so there is nothing circular about it. With too few outdoor
 * rounds to compute one, the self-reported figure stands in, and with neither
 * there is nothing to pull towards, so the round counts in full.
 */
export const SIMULATOR_WEIGHT = 0.25;

/**
 * A player's Handicap Index from their scoring record.
 *
 * Under three rounds there is nothing to calculate, so the self-reported figure
 * is returned and flagged provisional rather than inventing one.
 */
export function handicapIndex(
  records: readonly ScoringRecord[],
  selfReported: number | null,
  options: IndexOptions = {},
): HandicapResult {
  return indexFromDifferentials(
    records.map((r) => ({
      differential: differential(r.adjustedGross, r.courseRating, r.slope),
      playedOn: r.playedOn,
      simulator: r.simulator,
    })),
    selfReported,
    options,
  );
}

export type IndexOptions = {
  /** 0 to 1. Left out, a simulator round counts like any other. */
  simulatorWeight?: number;
};

/** The WHS selection over a set of differentials, with nothing house about it. */
function whs(
  differentials: readonly number[],
): { index: number; used: number } | null {
  if (differentials.length < MIN_ROUNDS_FOR_INDEX) return null;

  const { lowest, adjustment } =
    WHS_TABLE[Math.min(differentials.length, SCORING_RECORD_SIZE)];
  const best = [...differentials].sort((a, b) => a - b).slice(0, lowest);
  const average = best.reduce((sum, d) => sum + d, 0) / best.length;

  return { index: round1(average + adjustment), used: best.length };
}

/**
 * The same calculation from differentials already worked out.
 *
 * Callers that computed differentials while summarising rounds use this rather
 * than encoding them back into a synthetic gross score just to have them
 * recomputed.
 */
export function indexFromDifferentials(
  entries: readonly DifferentialEntry[],
  selfReported: number | null,
  { simulatorWeight = 1 }: IndexOptions = {},
): HandicapResult {
  const weight = Math.min(Math.max(simulatorWeight, 0), 1);

  // Most recent 20, newest first. The cut happens before any weighting, so a
  // sim round still takes up a slot in the record it was played into.
  const recent = [...entries]
    .sort((a, b) => b.playedOn.localeCompare(a.playedOn))
    .slice(0, SCORING_RECORD_SIZE)
    // At zero weight a simulator round is not in the record at all.
    .filter((r) => weight > 0 || !r.simulator);

  // Everything they have posted, which is what the profile reports, as
  // distinct from the twenty the calculation looks at.
  const posted = entries.length;
  const simulatorRounds = entries.filter((r) => r.simulator).length;

  if (recent.length < MIN_ROUNDS_FOR_INDEX) {
    return {
      status: "provisional",
      index: selfReported,
      roundsPosted: posted,
      roundsNeeded: MIN_ROUNDS_FOR_INDEX - recent.length,
      simulatorRounds,
    };
  }

  /*
    The house rule. Outdoor rounds set the anchor, then every simulator round
    is pulled that far towards it before the WHS selection runs. With no
    simulator rounds, or at full weight, nothing here changes the arithmetic
    and the result is the published method exactly.
  */
  const outdoor = recent.filter((r) => !r.simulator).map((r) => r.differential);
  const anchor = whs(outdoor)?.index ?? selfReported;

  const differentials = recent.map((r) =>
    r.simulator && weight < 1 && anchor !== null
      ? round1(anchor + weight * (r.differential - anchor))
      : r.differential,
  );

  const table = whs(differentials)!;

  return {
    status: "calculated",
    index: table.index,
    roundsPosted: posted,
    differentialsUsed: table.used,
    simulatorRounds,
    simulatorWeight: weight,
  };
}

/** Above this, a course's par is for 18 holes; at or below, for nine. */
export const NINE_HOLE_PAR_LIMIT = 45;

/**
 * The rating and par to measure nine holes against.
 *
 * A 9-hole course is rated for its nine, so its own figures stand. Nine holes
 * of an 18-hole course take half its rating and par: there is no separate
 * rating for each nine in the data.
 */
export function nineHoleRating(courseRating: number, coursePar: number): { rating: number; par: number } {
  return coursePar <= NINE_HOLE_PAR_LIMIT
    ? { rating: courseRating, par: coursePar }
    : { rating: courseRating / 2, par: coursePar / 2 };
}

/**
 * What a player is expected to score over nine holes they didn't play, as a
 * differential (the WHS method since 2024: 0.52 × index + 1.2).
 */
export function expectedNineDifferential(index: number): number {
  return 0.52 * index + 1.2;
}

/**
 * A nine-hole round as an 18-hole differential: the nine played, against the
 * nine's own rating, plus the expected differential for the other nine. With
 * no index to expect from, the nine counts twice.
 */
export function nineHoleDifferential(
  adjustedGross: number,
  nineRating: number,
  slope: number,
  index: number | null,
): number {
  if (slope <= 0) {
    throw new Error("Slope must be positive; it scales the whole calculation.");
  }

  const played = (113 / slope) * (adjustedGross - nineRating);

  return round1(index === null ? played * 2 : played + expectedNineDifferential(index));
}

/**
 * Course Handicap: the strokes a player receives at a particular tee.
 *
 *   index x (slope / 113) + (course rating - par)
 *
 * The rating-minus-par term is what makes a hard course give more strokes than
 * an easy one of the same slope.
 */
export function courseHandicap(
  index: number,
  slope: number,
  courseRating: number,
  par: number,
): number {
  return Math.round(index * (slope / 113) + (courseRating - par));
}

/**
 * Strokes received on each hole, allocated by stroke index.
 *
 * A course handicap of 20 gives one stroke on every hole and a second on the
 * two hardest. A plus handicap gives strokes BACK, starting from the easiest
 * hole — which is why this returns negatives rather than clamping at zero.
 */
export function strokesPerHole(
  handicap: number,
  strokeIndexes: Readonly<Record<number, number>>,
): Record<number, number> {
  const holes = Object.keys(strokeIndexes).map(Number);
  const result = Object.fromEntries(holes.map((h) => [h, 0]));

  if (holes.length === 0) return result;

  if (handicap >= 0) {
    for (let stroke = 0; stroke < handicap; stroke++) {
      // Wraps: past 18 strokes the hardest holes start receiving a second.
      const rank = (stroke % holes.length) + 1;
      const hole = holes.find((h) => strokeIndexes[h] === rank);

      if (hole !== undefined) result[hole] += 1;
    }
  } else {
    for (let stroke = 0; stroke < -handicap; stroke++) {
      // Plus handicaps give shots back from the easiest hole downwards.
      const rank = holes.length - (stroke % holes.length);
      const hole = holes.find((h) => strokeIndexes[h] === rank);

      if (hole !== undefined) result[hole] -= 1;
    }
  }

  return result;
}

/**
 * Adjusted gross: every hole capped at net double bogey.
 *
 * A blow-up hole should not distort a handicap, so WHS caps each hole at
 * par + 2 + strokes received before the differential is taken.
 *
 * Without a stroke allocation there is nothing to cap against, so the gross
 * total is returned unchanged rather than guessing.
 */
export function adjustedGross(
  strokesByHole: Readonly<Record<number, number>>,
  pars: Readonly<Record<number, number>>,
  received: Readonly<Record<number, number>> = {},
): number {
  return Object.entries(strokesByHole).reduce((total, [hole, strokes]) => {
    const par = pars[Number(hole)];
    if (par === undefined) return total + strokes;

    const cap = par + 2 + (received[Number(hole)] ?? 0);

    return total + Math.min(strokes, cap);
  }, 0);
}

/** One decimal, without the float drift that division introduces. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
