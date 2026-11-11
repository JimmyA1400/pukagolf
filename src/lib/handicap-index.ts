/**
 * Reading and writing a Handicap Index.
 *
 * THE SIGN TRAP
 * A "plus" handicap is better than scratch, and golfers write it with a leading
 * plus: +1.4. Arithmetically it is negative — that player gives strokes back —
 * so it is stored as -1.4 and displayed as "+1.4". Getting this backwards makes
 * the best player in the league look like the worst, and every net score wrong.
 *
 * So: stored numbers run from -10 (very strong) to 54 (maximum), and the
 * display sign is inverted for negatives only.
 */

/** WHS maximum, and a sane floor for a self-reported plus handicap. */
export const MIN_INDEX = -10;
export const MAX_INDEX = 54;

export type ParsedIndex =
  | { ok: true; value: number }
  | { ok: false; reason: string };

/**
 * Parse what a golfer types into a stored index.
 *
 * "+1.4" and "-1.4" both mean the same player — one uses the golf convention,
 * the other the arithmetic one — and both store as -1.4.
 */
export function parseHandicapInput(input: string): ParsedIndex {
  const trimmed = input.trim();

  if (trimmed === "") {
    return { ok: false, reason: "Enter a handicap index." };
  }

  const match = /^([+-]?)(\d{1,2})(?:\.(\d))?$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      reason: "Use a number with up to one decimal, like 12.4 or +1.4.",
    };
  }

  const [, sign, whole, decimal] = match;
  const magnitude = Number(`${whole}.${decimal ?? "0"}`);

  // Either sign means "better than scratch"; no sign means a normal handicap.
  const value = sign === "" ? magnitude : -magnitude;

  if (value < MIN_INDEX || value > MAX_INDEX) {
    return {
      ok: false,
      reason: `A handicap index runs from +${Math.abs(MIN_INDEX)} to ${MAX_INDEX}.`,
    };
  }

  // Guard against float drift from the division above.
  return { ok: true, value: Math.round(value * 10) / 10 };
}

/** Stored index back to how golfers read it: -1.4 -> "+1.4", 12.3 -> "12.3". */
export function formatHandicapIndex(
  value: number | null | undefined,
): string {
  if (value === null || value === undefined) return "—";

  const fixed = Math.abs(value).toFixed(1);

  return value < 0 ? `+${fixed}` : fixed;
}

/** True when the index is better than scratch. */
export function isPlusHandicap(value: number): boolean {
  return value < 0;
}
