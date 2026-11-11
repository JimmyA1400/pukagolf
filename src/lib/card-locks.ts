/**
 * Why a card can't be changed, in the words a player would use.
 *
 * Four different things lock a card, and they mean different things to the
 * people on it: the group signed it, a club admin locked it, the week was
 * marked final, or the season was closed. Saying "signed off" for all four
 * told players their group had signed cards it never saw. The database keeps
 * the same four names (card_lock_reasons() in 0053) for the card's history.
 */

export type LockReason = "signed_off" | "locked" | "week_final" | "season_closed";

/** How one card's own lock was made, as card_locks records it. */
export type CardLock = { how: "signed" | "admin"; by: string | null; at?: string | null };

/** Every reason that applies to one card, what happened to the card first. */
export function lockReasons({
  cardLock,
  weekFinal,
  seasonClosed,
}: {
  cardLock?: CardLock | null;
  weekFinal?: boolean;
  seasonClosed?: boolean;
}): LockReason[] {
  return [
    cardLock ? (cardLock.how === "admin" ? "locked" : "signed_off") : null,
    weekFinal ? "week_final" : null,
    seasonClosed ? "season_closed" : null,
  ].filter((r): r is LockReason => r !== null);
}

/** "Nov 4, 6:12 PM", for when a card was locked. */
export function lockTime(at: string | null | undefined): string {
  if (!at) return "";
  return new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Signed off by Greg G. · week marked final", for a card's caption. */
export function lockSummary(
  reasons: readonly LockReason[],
  signer?: string | null,
  at?: string | null,
): string {
  const when = at ? `, ${lockTime(at)}` : "";
  const label = (reason: LockReason) =>
    reason === "signed_off"
      ? signer
        ? `Signed off by ${signer}${when}`
        : "Signed off by the group"
      : reason === "locked"
        ? `Locked by ${signer ?? "a club admin"}${when}`
        : reason === "week_final"
          ? "Week marked final"
          : "Season closed";

  return reasons.map((reason, i) => (i === 0 ? label(reason) : lowerFirst(label(reason)))).join(" · ");
}

/** The warning before a club admin changes a locked card: what happened, plainly. */
export function lockWarning(
  reasons: readonly LockReason[],
  playerName: string,
  signer?: string | null,
): string {
  const parts: string[] = [];

  if (reasons.includes("signed_off")) {
    parts.push(
      `${playerName}’s card was signed off by ${signer ?? "the group"}: the group agreed these scores.`,
    );
  } else if (reasons.includes("locked")) {
    parts.push(`${playerName}’s card was locked by ${signer ? `${signer}, a club admin` : "a club admin"}.`);
  } else {
    parts.push(`Nobody signed ${playerName}’s card.`);
  }

  if (reasons.includes("week_final")) {
    parts.push("The week is marked final, which locks every card in it and makes its points official.");
  }
  if (reasons.includes("season_closed")) {
    parts.push("The season is closed: its standings and champion are settled.");
  }

  return parts.join(" ");
}

/** " after the week was marked final", for a line in the card's history. */
export function lockedWhen(cardWas: string | null | undefined): string {
  const phrases = (cardWas ?? "")
    .split(",")
    .map((reason): string | null => {
      switch (reason.trim()) {
        case "signed_off":
          return "the group signed off the card";
        case "locked":
          return "a club admin locked the card";
        case "week_final":
          return "the week was marked final";
        case "season_closed":
          return "the season was closed";
        default:
          return null;
      }
    })
    .filter((p): p is string => p !== null);

  if (phrases.length === 0) return "";
  if (phrases.length === 1) return ` after ${phrases[0]}`;

  return ` after ${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

/** "Locked by Hank H." → "locked by Hank H.": names keep their capitals. */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
