/**
 * What to warn about before a week is marked final.
 *
 * Final makes the week's points official and locks every card in it, so the
 * pro shop is asked first, and told plainly about anything that looks wrong:
 * cards still open, a date that hasn't come, a week still being set up.
 */

export type OpenCard = { name: string; posted: number };

export function finalWarnings({
  playedOn,
  status,
  holeCount,
  open,
  today,
}: {
  /** The week's date, YYYY-MM-DD. */
  playedOn: string;
  status: "setup" | "live" | "final";
  holeCount: number;
  /** Cards without every hole. */
  open: readonly OpenCard[];
  /** Today, YYYY-MM-DD, in the club's local time. */
  today: string;
}): string[] {
  const warnings: string[] = [];

  if (playedOn > today) {
    warnings.push(`It's dated ${playedOn}, which hasn't come yet.`);
  }
  if (status === "setup") {
    warnings.push("It's still being set up: the groups haven't been sent out to play.");
  }
  if (open.length > 0) {
    warnings.push(
      `${unfinishedCards(open, holeCount)}. ${open.length === 1 ? "It" : "They"} won't earn points.`,
    );
  }

  return warnings;
}

/**
 * The cards still open, with the holes each is short: "2 cards aren't
 * finished: Mo Mulligan (4 holes left), Sal Sandtrap (not started)".
 */
export function unfinishedCards(open: readonly OpenCard[], holeCount: number): string {
  const left = (card: OpenCard) => {
    const short = holeCount - card.posted;
    if (card.posted === 0) return "not started";
    return `${short} ${short === 1 ? "hole" : "holes"} left`;
  };

  return `${open.length === 1 ? "One card isn't" : `${open.length} cards aren't`} finished: ${open
    .map((card) => `${card.name} (${left(card)})`)
    .join(", ")}`;
}

/** The cards in a week without every hole, from round_completion(). */
export function openCards(
  completion: { holeCount: number; players: { name: string; posted: number }[] } | null,
  holeCount: number,
): OpenCard[] {
  const holes = completion?.holeCount ?? holeCount;
  return (completion?.players ?? []).filter((p) => p.posted < holes);
}

/** Today in this browser's time zone, as YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The confirmation itself, in one sentence. */
export function finalQuestion(weekName: string): string {
  return `Make ${weekName} final? Its points become official, and every card in it is locked: only a club admin can change one after this, with a reason.`;
}
