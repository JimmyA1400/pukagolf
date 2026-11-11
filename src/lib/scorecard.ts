/**
 * Scorecard shape: a par row and a strokes row, split at the turn.
 *
 * Eighteen columns don't fit on a phone, and paper scorecards already solve
 * this by breaking at the turn — front nine with an OUT subtotal, back nine
 * with IN, then the round total. Nine-hole rounds produce a single segment.
 */

import { roundHoles } from "./holes";
import { formatToPar, type Score } from "./leaderboard";

export type ScorecardCell = {
  hole: number;
  par: number;
  /** Null until the assigned scorer enters this hole. */
  strokes: number | null;
  /** Distance from the tee being played. Null when the course has none. */
  yards: number | null;
  /**
   * Stroke index, 1 = hardest. Null when the course was never rated.
   *
   * Course-level rather than per tee: the data source publishes one index per
   * hole, not one per tee set. Courses that genuinely differ by tee would need
   * a per-tee column, which nothing currently supplies.
   */
  strokeIndex: number | null;
};

export type ScorecardSegment = {
  /** "OUT" for the front nine, "IN" for the back, "TOTAL" when unsplit. */
  label: "OUT" | "IN" | "TOTAL";
  cells: ScorecardCell[];
  parTotal: number;
  /** Strokes over the holes played so far in this segment. */
  strokesTotal: number;
  holesPlayed: number;
};

export type Scorecard = {
  segments: ScorecardSegment[];
  parTotal: number;
  strokesTotal: number;
  /** Par for the holes played, which is what toPar is measured against. */
  parToDate: number;
  toPar: number;
  /** Ready to render: "E", "+3", "-2". */
  toParLabel: string;
  thru: number;
  /** True once every hole on the card has a score. */
  complete: boolean;
};

export type CoursePars = Readonly<Record<number, number>>;

/**
 * Per-hole detail beyond par. Both are optional — plenty of imported courses
 * carry neither — and grouped rather than trailing as positional arguments.
 */
export type ScorecardExtras = {
  /** Yardage per hole for the tee being played. */
  yards?: Readonly<Record<number, number>>;
  /** Stroke index per hole, 1 = hardest. */
  strokeIndexes?: Readonly<Record<number, number>>;
};

export function buildScorecard(
  pars: CoursePars,
  scores: readonly Score[],
  holeCount = 18,
  { yards, strokeIndexes }: ScorecardExtras = {},
  /** 10 for a back-nine week; its holes keep their real numbers. */
  startHole = 1,
): Scorecard {
  const strokesByHole = new Map(scores.map((s) => [s.hole, s.strokes]));

  const cells: ScorecardCell[] = roundHoles(holeCount, startHole).map((hole) => ({
    hole,
    par: pars[hole] ?? 0,
    strokes: strokesByHole.get(hole) ?? null,
    yards: yards?.[hole] ?? null,
    strokeIndex: strokeIndexes?.[hole] ?? null,
  }));

  // Split at the turn when the round crosses it. A nine is one segment,
  // labelled IN when it's the back nine, as a paper card would be.
  const front = cells.filter((c) => c.hole <= 9);
  const back = cells.filter((c) => c.hole > 9);
  const segments =
    front.length > 0 && back.length > 0
      ? [segment("OUT", front), segment("IN", back)]
      : [segment(back.length > 0 ? "IN" : "TOTAL", cells)];

  const played = cells.filter((c) => c.strokes !== null);
  const parToDate = played.reduce((sum, c) => sum + c.par, 0);
  const strokesTotal = played.reduce((sum, c) => sum + c.strokes!, 0);
  const toPar = strokesTotal - parToDate;

  return {
    segments,
    parTotal: cells.reduce((sum, c) => sum + c.par, 0),
    strokesTotal,
    parToDate,
    toPar,
    // Par data is guaranteed here, so the label is never null.
    toParLabel: formatToPar(toPar)!,
    thru: played.length,
    complete: played.length === holeCount,
  };
}

function segment(
  label: ScorecardSegment["label"],
  cells: ScorecardCell[],
): ScorecardSegment {
  const played = cells.filter((c) => c.strokes !== null);

  return {
    label,
    cells,
    parTotal: cells.reduce((sum, c) => sum + c.par, 0),
    strokesTotal: played.reduce((sum, c) => sum + c.strokes!, 0),
    holesPlayed: played.length,
  };
}

/**
 * The next hole the scorer may enter, or null when the card is full.
 *
 * Mirrors the `scores_sequential` trigger. Finds the first empty hole rather
 * than counting from `thru`, because the admin bypasses that trigger and can
 * therefore leave a gap — after which "one past the last entry" would point at
 * the wrong hole and the write would be rejected.
 *
 * Already-entered holes stay editable; that's a correction, not a new entry.
 */
export function nextEnterableHole(card: Scorecard): number | null {
  const cells = card.segments.flatMap((s) => s.cells);

  return cells.find((c) => c.strokes === null)?.hole ?? null;
}

/** How a single hole reads against par: birdie, bogey and friends. */
export function holeResult(
  // Only the two fields it actually reads, so callers that have a par and a
  // score need not fabricate a whole scorecard cell.
  cell: Pick<ScorecardCell, "par" | "strokes"> & Partial<ScorecardCell>,
): string | null {
  if (cell.strokes === null) return null;

  const diff = cell.strokes - cell.par;

  if (diff <= -3) return "albatross";
  if (diff === -2) return "eagle";
  if (diff === -1) return "birdie";
  if (diff === 0) return "par";
  if (diff === 1) return "bogey";
  if (diff === 2) return "double bogey";

  return `+${diff}`;
}
