/**
 * Turning scores into finishing positions.
 *
 * Kept out of the results form so the ranking can be tested on its own — ties
 * are where this sort of thing usually goes wrong.
 */

/**
 * Rank by score, ties sharing a place: 1, T2, T2, 4.
 *
 * Standard competition ranking, so two players tied for second means nobody
 * finishes third.
 *
 * A player with no score is left out entirely rather than ranked last: they
 * entered and did not finish, which is not the same as finishing badly.
 */
export function positionsFromGross(
  rows: readonly { playerId: string; gross: number | null }[],
): Record<string, number> {
  const scored = rows
    .filter((r) => r.gross !== null)
    .sort((a, b) => a.gross! - b.gross!);

  const positions: Record<string, number> = {};

  scored.forEach((row, i) => {
    const previous = scored[i - 1];

    positions[row.playerId] =
      previous && previous.gross === row.gross
        ? positions[previous.playerId]
        : i + 1;
  });

  return positions;
}
