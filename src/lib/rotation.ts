/**
 * Scorer rotation.
 *
 * Spec: in a group of N players, player[i] scores player[i+1], wrapping so the
 * last scores the first. Generic in N — never hardcoded to a foursome.
 *
 * The ring produced here is only a *seed*. Once written to scorer_assignments
 * the admin owns it and may reassign freely mid-round, so nothing downstream
 * may recompute this and assume it still matches the database.
 */

export type PlayerId = string;

export type Assignment = {
  /** The player doing the entering. */
  scorerId: PlayerId;
  /** The player whose strokes are being entered. */
  scoredId: PlayerId;
};

/** Groups of one have no valid scorer — the wrap points at the player themselves. */
export const MIN_GROUP_SIZE = 2;

export class InvalidGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGroupError";
  }
}

/**
 * Seed the rotation for a group, in the given order.
 *
 * Order is significant: it defines the ring, so callers should pass players in
 * their stored group position, not an arbitrary or set-derived order.
 */
export function buildRotation(playerIds: readonly PlayerId[]): Assignment[] {
  assertValidGroup(playerIds);

  return playerIds.map((scorerId, i) => ({
    scorerId,
    scoredId: playerIds[(i + 1) % playerIds.length],
  }));
}

/**
 * Re-close the ring after players leave.
 *
 * A dropout breaks two edges, not one: the leaver's own assignment dies, and
 * whoever they were scoring is left unscored. Reseeding over the survivors
 * repairs both in a single operation and keeps the ring a ring.
 *
 * Relative order of the remaining players is preserved so the repair is as
 * small a change as possible from what the group already had.
 */
export function reseedAfterDropout(
  playerIds: readonly PlayerId[],
  droppedIds: readonly PlayerId[],
): Assignment[] {
  const dropped = new Set(droppedIds);
  const remaining = playerIds.filter((id) => !dropped.has(id));

  if (remaining.length < MIN_GROUP_SIZE) {
    throw new InvalidGroupError(
      `Removing ${dropped.size} player(s) leaves ${remaining.length}, below the ` +
        `minimum of ${MIN_GROUP_SIZE}. Merge the group into another tee time instead.`,
    );
  }

  return buildRotation(remaining);
}

/** The single player this scorer is responsible for, or null if they hold no assignment. */
export function scoredBy(
  assignments: readonly Assignment[],
  scorerId: PlayerId,
): PlayerId | null {
  return assignments.find((a) => a.scorerId === scorerId)?.scoredId ?? null;
}

function assertValidGroup(playerIds: readonly PlayerId[]): void {
  if (playerIds.length < MIN_GROUP_SIZE) {
    throw new InvalidGroupError(
      `A group needs at least ${MIN_GROUP_SIZE} players to rotate scoring; got ` +
        `${playerIds.length}. A lone player has nobody to score them.`,
    );
  }

  const unique = new Set(playerIds);
  if (unique.size !== playerIds.length) {
    throw new InvalidGroupError("The same player appears twice in one group.");
  }
}
