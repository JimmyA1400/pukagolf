/**
 * What state an outing is in, and whether it is safe to delete.
 *
 * The same rule is enforced in `admin_delete_event`, because a check that
 * lived only here would be bypassed by a POST straight to PostgREST.
 */

export type EventStatus = "upcoming" | "live" | "completed" | "abandoned";

export type EventActivity = {
  /** Set when the organiser closed the outing out. */
  completedAt: string | null;
  /** ISO date, "2026-09-10". */
  playedOn: string;
  scoreCount: number;
  /** The home page's demo outing, which the database refuses to delete. */
  isDemo?: boolean;
};

export function eventStatus(
  event: EventActivity,
  today = isoToday(),
): EventStatus {
  if (event.completedAt !== null) return "completed";
  if (event.playedOn > today) return "upcoming";
  if (event.scoreCount > 0 && event.playedOn === today) return "live";

  // Its day has been and gone without anyone closing it out. An outing with
  // scores on it is still worth keeping; one without was never played.
  return "abandoned";
}

/**
 * Deleting is permanent and takes the scores with it, so the one case it
 * refuses is the one where someone might be part-way round: today's outing,
 * not closed out, with cards already on it.
 *
 * Everything else goes, including an outing created by mistake this morning —
 * with no scores on it there is nothing to lose.
 */
export function canDeleteEvent(
  event: EventActivity,
  today = isoToday(),
): boolean {
  if (event.isDemo) return false;

  return eventStatus(event, today) !== "live";
}

/** Why the button is disabled, in words a person can act on. */
export function deleteRefusal(
  event: EventActivity,
  today = isoToday(),
): string | null {
  if (event.isDemo) {
    return "The home page opens this demo, so it can't be deleted.";
  }

  return canDeleteEvent(event, today)
    ? null
    : "Someone may still be playing this. Close it out first.";
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
