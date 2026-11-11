import type { SideLabel } from "@/components/league/Leaderboard";
import { formatGameScore, type SideScore } from "@/lib/games";

/**
 * Group against group, best ball.
 *
 * A side game, not the week's: whatever the week is being scored as, this
 * takes the lowest card in each tee time on every hole and ranks the groups
 * against each other. It reads the same scores as everything else, so nothing
 * has to be entered twice and switching it off leaves no trace.
 *
 * A group's hole only counts once everyone in it has posted, which is what
 * makes the comparison fair between a threesome and a foursome — the same
 * rule the real best-ball board uses (see src/lib/games.ts).
 */
export function GroupMatch({
  rows,
  label,
  holeCount,
  viewerId,
}: {
  /** Already ranked as best ball, one row per tee time. */
  rows: readonly SideScore[];
  label: (row: SideScore) => SideLabel;
  holeCount: number;
  viewerId: string;
}) {
  if (rows.length < 2) {
    return (
      <p className="border border-hairline bg-card px-4 py-3 font-mono text-xs text-ink-soft">
        Only one group is out this week, so there is nobody to play against.
      </p>
    );
  }

  return (
    <ol className="border border-hairline bg-card px-4">
      {rows.map((row) => {
        const { title, note } = label(row);
        const isViewer = row.playerIds.includes(viewerId);

        return (
          <li
            key={row.id}
            className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-dashed border-hairline py-2.5 last:border-b-0 ${
              isViewer ? "-mx-4 bg-highlight px-4" : ""
            }`}
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="w-4 shrink-0 font-mono text-sm text-ink-soft">
                {row.position}
              </span>
              <span className="min-w-0">
                <span className="block font-display text-[0.95rem] font-semibold">
                  {title}
                </span>
                {note && (
                  <span className="block font-mono text-[0.7rem] text-ink-soft">
                    {note}
                  </span>
                )}
              </span>
            </span>

            <span className="shrink-0 text-right">
              <span
                className={`font-mono text-sm font-bold tabular-nums ${
                  row.toPar !== null && row.toPar < 0 ? "text-clay" : ""
                }`}
              >
                {formatGameScore(row, "best_ball")}
              </span>
              <span className="ml-2 font-mono text-xs text-ink-soft">
                {row.thru >= holeCount ? "final" : `thru ${row.thru}`}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
