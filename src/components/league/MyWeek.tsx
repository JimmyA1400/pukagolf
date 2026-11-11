import type { Player, TeeGroup } from "@/lib/demo-round";
import { SCORING_MODES, type Assignment, type ScoringMode } from "@/lib/scoring-rules";

/**
 * What a player looks for first on the day: when they tee off, who with, and
 * whose card they're keeping. All of it was on the page already, but spread
 * across the tee sheet and the Scorecards tab.
 */
export function MyWeek({
  viewerId,
  players,
  groups,
  assignments,
  playedOn,
  mode = "partner",
  noLogin = [],
  isAdmin = false,
}: {
  viewerId: string;
  players: readonly Player[];
  groups: readonly TeeGroup[];
  assignments: readonly Assignment[];
  playedOn: string;
  /** Who enters scores in this league, which is what the card lines say. */
  mode?: ScoringMode;
  /** Players with no login, who can't keep anybody's card. */
  noLogin?: readonly string[];
  /** A club admin, who puts people in groups rather than asking someone to. */
  isAdmin?: boolean;
}) {
  // Before the groups exist the RSVP banner is the thing to show.
  if (groups.length === 0) return null;

  const short = (id: string) => players.find((p) => p.id === id)?.short ?? "?";
  const group = groups.find((g) => g.playerIds.includes(viewerId));
  const keeping = assignments.find((a) => a.scorerId === viewerId)?.scoredId ?? null;
  const keptBy = assignments.find((a) => a.scoredId === viewerId)?.scorerId ?? null;
  const partners = group ? group.playerIds.filter((id) => id !== viewerId).map(short) : [];

  // Noon, so the date can't slip a day in any US time zone.
  const day = new Date(`${playedOn}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <section
      aria-labelledby="my-week-title"
      className="border-2 border-forest bg-card px-4 py-4"
    >
      <p className="meta">{day}</p>
      <h2 id="my-week-title" className="font-display text-xl font-bold">
        Your week
      </h2>

      {!group ? (
        <p className="mt-1 font-mono text-xs text-ink-soft">
          {isAdmin
            ? "You're not in a group this week. Add yourself on the Groups page if you're playing."
            : "You're not in a group this week. If you should be, tell the pro shop."}
        </p>
      ) : (
        <>
          <p className="mt-2 font-display text-2xl font-bold">
            {group.label} · {group.time}
          </p>
          <p className="mt-1 font-mono text-xs">
            {partners.length > 0
              ? // A short name already ends "M.", so don't add a second stop.
                `With ${listNames(partners)}`.replace(/([^.])$/, "$1.")
              : "Nobody else is in your group yet."}
          </p>

          <ul className="mt-3 space-y-1 border-t border-dashed border-hairline pt-2 font-mono text-xs">
            {mode === "partner" ? (
              <>
                <li>
                  {keeping ? (
                    <>
                      You&rsquo;re keeping <b>{short(keeping)}&rsquo;s</b> card.
                    </>
                  ) : (
                    "You aren't keeping anyone's card."
                  )}
                </li>
                <li>
                  {!keptBy
                    ? "Nobody is keeping your card yet."
                    : noLogin.includes(keptBy)
                      ? `${short(keptBy)} has no login, so you keep your own card too.`
                      : `${short(keptBy)} keeps yours.`}
                </li>
              </>
            ) : (
              <li>
                {SCORING_MODES.find((m) => m.id === mode)?.label}:{" "}
                {mode === "self"
                  ? "you keep your own card."
                  : "anyone in your group keeps every card in it, yours included."}
              </li>
            )}
            {/* Self Scoring leaves a player with no login without a keeper. */}
            {mode === "self" && group && group.playerIds.some((id) => id !== viewerId && noLogin.includes(id)) && (
              <li className="text-clay">
                {listNames(group.playerIds.filter((id) => id !== viewerId && noLogin.includes(id)).map(short))}{" "}
                {group.playerIds.filter((id) => id !== viewerId && noLogin.includes(id)).length === 1 ? "has" : "have"}{" "}
                no login, so can&rsquo;t keep their own card. Write it on paper and take it to
                the pro shop, who put it in.
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}

/** "Riley M., Sam K. and Jo P." */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");

  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
