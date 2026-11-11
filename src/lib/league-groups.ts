/**
 * Splitting the week's players into groups.
 *
 * admin_build_week_from_rsvps() does this in the database and is the one that
 * counts; this is the same arithmetic, so the editor can show what "Build
 * groups" will produce before anyone presses it. Keep the two in step.
 */

/** A tee time holds four. */
export const GROUP_CAPACITY = 4;

/**
 * How many players go in each group, earliest group first.
 *
 * As even as possible, so eleven players go off 4-4-3 rather than 4-4-2-1,
 * and never a group of one: a player on their own has nobody to keep their
 * card, and the scoring rotation needs at least two. Fewer than two players
 * makes no groups at all.
 */
export function groupSizes(players: number, capacity = GROUP_CAPACITY): number[] {
  if (players < 2) return [];

  let groups = Math.ceil(players / capacity);

  // Only a capacity of 2 can get here with an odd number of players: 3 would
  // otherwise split 2-1. One group of three beats a group of one.
  while (groups > 1 && Math.floor(players / groups) < 2) groups -= 1;

  const base = Math.floor(players / groups);
  const extra = players % groups;

  return Array.from({ length: groups }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * The players, already in the order they should be seated, cut into groups
 * of groupSizes().
 */
export function planGroups<T>(players: readonly T[], capacity = GROUP_CAPACITY): T[][] {
  const out: T[][] = [];
  let taken = 0;

  for (const size of groupSizes(players.length, capacity)) {
    out.push(players.slice(taken, taken + size));
    taken += size;
  }

  return out;
}

/**
 * Order for seating: whoever asked for the earliest tee time goes first, and
 * players with no preference fill in after, alphabetically so the result is
 * the same every time it is built.
 */
export function bySeatingOrder(
  a: { name: string; preferredTeeTime: string | null },
  b: { name: string; preferredTeeTime: string | null },
): number {
  if (a.preferredTeeTime !== b.preferredTeeTime) {
    if (a.preferredTeeTime === null) return 1;
    if (b.preferredTeeTime === null) return -1;
    return a.preferredTeeTime < b.preferredTeeTime ? -1 : 1;
  }

  return a.name.localeCompare(b.name);
}
