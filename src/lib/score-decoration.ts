/**
 * How a score is marked on a scorecard.
 *
 * The convention golfers already read without being told: circles for under
 * par, boxes for over, nothing for par. The number of rings is the number of
 * strokes away, so a triple box is visibly worse than a double at a glance.
 */
export type Decoration =
  | "none"
  | "circle"
  | "double-circle"
  | "box"
  | "double-box"
  | "triple-box";

/**
 * Decoration for a score against its par.
 *
 * Undecorated when either number is missing. A hole with no par — which happens
 * when the course data is incomplete — cannot be compared to anything, and
 * guessing par 4 would mark scores as bogeys that aren't.
 */
export function scoreDecoration(
  strokes: number | null | undefined,
  par: number | null | undefined,
): Decoration {
  if (
    strokes === null ||
    strokes === undefined ||
    par === null ||
    par === undefined ||
    par <= 0
  ) {
    return "none";
  }

  const diff = strokes - par;

  if (diff <= -2) return "double-circle";
  if (diff === -1) return "circle";
  if (diff === 0) return "none";
  if (diff === 1) return "box";
  if (diff === 2) return "double-box";

  return "triple-box";
}

/** How many concentric rings a decoration draws. */
export function ringCount(decoration: Decoration): number {
  switch (decoration) {
    case "none":
      return 0;
    case "circle":
    case "box":
      return 1;
    case "double-circle":
    case "double-box":
      return 2;
    case "triple-box":
      return 3;
  }
}

/** True for the under-par decorations, which are drawn round. */
export function isRound(decoration: Decoration): boolean {
  return decoration === "circle" || decoration === "double-circle";
}

/**
 * Screen-reader wording, since the shape carries meaning a border cannot.
 *
 * Kept alongside the decoration so the two never drift apart.
 */
export function describeScore(
  strokes: number | null | undefined,
  par: number | null | undefined,
): string | null {
  if (strokes === null || strokes === undefined) return null;
  if (par === null || par === undefined || par <= 0) return `${strokes}`;

  const diff = strokes - par;

  if (diff <= -3) return `${strokes}, albatross`;
  if (diff === -2) return `${strokes}, eagle`;
  if (diff === -1) return `${strokes}, birdie`;
  if (diff === 0) return `${strokes}, par`;
  if (diff === 1) return `${strokes}, bogey`;
  if (diff === 2) return `${strokes}, double bogey`;
  if (diff === 3) return `${strokes}, triple bogey`;

  return `${strokes}, ${diff} over par`;
}
