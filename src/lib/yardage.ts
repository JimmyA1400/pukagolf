/**
 * Choosing which tee's yardages to show.
 *
 * A course carries several sets and the group decides which they're playing, so
 * this only picks a sensible opening default — the UI offers a switch.
 */

export type HoleYardages = Readonly<Record<string, number>>;

/**
 * Rough order of how commonly a set gets played, middle tees first.
 *
 * Not a judgement about anyone's game: showing the tips by default would put
 * the least representative number on most scorecards.
 */
const PREFERENCE = [
  "white",
  "blue",
  "yellow",
  "gold",
  "green",
  "red",
  "black",
];

/** Every tee colour that appears on at least one hole, most complete first. */
export function availableTees(
  holes: readonly { yardages: HoleYardages }[],
): string[] {
  const counts = new Map<string, number>();

  for (const hole of holes) {
    for (const [tee, yards] of Object.entries(hole.yardages ?? {})) {
      if (typeof yards === "number" && yards > 0) {
        counts.set(tee, (counts.get(tee) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => {
      // Most holes covered wins; a set missing half the course is no default.
      if (a[1] !== b[1]) return b[1] - a[1];

      const rank = (tee: string) => {
        const i = PREFERENCE.indexOf(tee.toLowerCase());

        return i === -1 ? PREFERENCE.length : i;
      };

      return rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]);
    })
    .map(([tee]) => tee);
}

/** The default tee to show, or null when the course has no yardages at all. */
export function preferredTee(
  holes: readonly { yardages: HoleYardages }[],
): string | null {
  const available = availableTees(holes);
  if (available.length === 0) return null;

  // Among the sets that cover the most holes, honour the preference order.
  const best = available.filter((tee) => coverage(holes, tee) === coverage(holes, available[0]));

  for (const wanted of PREFERENCE) {
    const match = best.find((tee) => tee.toLowerCase() === wanted);
    if (match) return match;
  }

  return best[0];
}

/** How many holes have a yardage for this tee. */
export function coverage(
  holes: readonly { yardages: HoleYardages }[],
  tee: string,
): number {
  return holes.filter((h) => {
    const yards = (h.yardages ?? {})[tee];

    return typeof yards === "number" && yards > 0;
  }).length;
}

/** Out, in and total yardage for a tee. */
export function yardageTotals(
  holes: readonly { hole: number; yardages: HoleYardages }[],
  tee: string | null,
): { out: number; in: number; total: number } {
  if (!tee) return { out: 0, in: 0, total: 0 };

  const yards = (h: { yardages: HoleYardages }) => (h.yardages ?? {})[tee] ?? 0;
  const ordered = [...holes].sort((a, b) => a.hole - b.hole);
  const out = ordered.slice(0, 9).reduce((sum, h) => sum + yards(h), 0);
  const back = ordered.slice(9).reduce((sum, h) => sum + yards(h), 0);

  return { out, in: back, total: out + back };
}

/** Title-cased tee name for display: "white" -> "White". */
export function teeLabel(tee: string): string {
  return tee.charAt(0).toUpperCase() + tee.slice(1);
}

/** A tee's rating and slope, which belong to the tee rather than the course. */
export type TeeRating = {
  tee: string;
  courseRating: number | null;
  slope: number | null;
  /** The source's own total, used when hole yardages are incomplete. */
  statedYardage: number | null;
};

export type TeeOption = {
  tee: string;
  label: string;
  /** Summed hole yardages, or the source's total when holes are missing. */
  totalYards: number;
  courseRating: number | null;
  slope: number | null;
};

/**
 * Every tee as a selectable option, longest first.
 *
 * Sorted by total yardage rather than by name: a golfer picking a tee is
 * choosing a length, so the list should read as one.
 */
export function teeOptions(
  holes: readonly { hole: number; yardages: HoleYardages }[],
  ratings: readonly TeeRating[] = [],
): TeeOption[] {
  const byTee = new Map(ratings.map((r) => [r.tee.toLowerCase(), r]));
  const measured = availableTees(holes);
  const known = new Set(measured.map((tee) => tee.toLowerCase()));

  // A rated tee is a tee even when no hole has a yardage for it, as on a
  // course entered by hand. Leaving it out would leave net with no rating to
  // work from, and the leaderboard disagreeing with the standings.
  const ratedOnly = ratings
    .filter((r) => r.courseRating !== null && r.slope !== null && !known.has(r.tee.toLowerCase()))
    .map((r) => r.tee);

  return [...measured, ...ratedOnly]
    .map((tee) => {
      const rating = byTee.get(tee.toLowerCase());
      const summed = yardageTotals(holes, tee).total;

      return {
        tee,
        label: teeLabel(tee),
        // The course's own total wins over the sum of its holes. Hole data is
        // frequently partial — one real course has three of eighteen measured
        // — and summing that would report White as 617 yards and sort the
        // dropdown by nonsense. Summing is the fallback, not the truth.
        totalYards: rating?.statedYardage ?? summed,
        courseRating: rating?.courseRating ?? null,
        slope: rating?.slope ?? null,
      };
    })
    .sort((a, b) => b.totalYards - a.totalYards || a.tee.localeCompare(b.tee));
}

/**
 * The tee to select when nothing else decides it.
 *
 * The longest, per the spec. `preferred` wins when the player has saved one and
 * the course actually has it — a saved preference for a tee this course doesn't
 * offer should not leave the card blank.
 */
export function defaultTee(
  options: readonly TeeOption[],
  preferred?: string | null,
): string | null {
  if (options.length === 0) return null;

  if (preferred) {
    const match = options.find(
      (o) => o.tee.toLowerCase() === preferred.toLowerCase(),
    );
    if (match) return match.tee;
  }

  return options[0].tee;
}
