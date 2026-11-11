import type { Player } from "@/lib/demo-round";
import { buildLeaderboard, formatToPar, type Score } from "@/lib/leaderboard";
import type { CoursePars } from "@/lib/scorecard";

type WhosWhereProps = {
  players: readonly Player[];
  scores: readonly Score[];
  pars: CoursePars;
  holeCount: number;
  viewerId: string;
  /** 10 for a back-nine week. */
  startHole?: number;
};

/** Where each player is on the course, and how they're scoring while there. */
export function WhosWhere({
  players,
  scores,
  pars,
  holeCount,
  viewerId,
  startHole = 1,
}: WhosWhereProps) {
  // Reuse the leaderboard rather than recomputing: same totals, same rules.
  const standings = buildLeaderboard(
    scores,
    players.map((p) => p.id),
    { pars },
  );
  const byId = new Map(players.map((p) => [p.id, p]));

  // Furthest round the course first — this answers "who's still out there".
  const rows = [...standings].sort((a, b) => b.thru - a.thru);

  return (
    <div className="space-y-2">
      {rows.map((entry) => {
        const player = byId.get(entry.playerId)!;
        // They are playing the hole after the last one they finished.
        const onHole = startHole + Math.min(entry.thru, holeCount - 1);
        const progress = (entry.thru / holeCount) * 100;
        const score = entry.thru === 0 ? "—" : formatToPar(entry.toPar);

        return (
          <div
            key={entry.playerId}
            className={`flex items-center gap-3 border border-hairline px-4 py-3 ${
              entry.playerId === viewerId ? "bg-highlight" : "bg-card"
            }`}
          >
            <span className="w-20 shrink-0 truncate font-display text-sm font-semibold">
              {player.short}
            </span>

            <span
              className={`w-10 shrink-0 text-right font-mono text-sm font-bold tabular-nums ${
                entry.toPar !== null && entry.toPar < 0 ? "text-clay" : ""
              }`}
            >
              {score ?? entry.strokes}
            </span>

            <div className="relative h-2 min-w-0 flex-1 rounded-full bg-sand">
              <div
                className="h-full rounded-full bg-forest"
                style={{ width: `${progress}%` }}
              />
              <span
                className="absolute -top-1.5 -translate-x-1/2 text-xs leading-none"
                style={{ left: `${progress}%` }}
                aria-hidden
              >
                ⛳
              </span>
            </div>

            <span className="w-20 shrink-0 text-right font-mono text-xs text-ink-soft">
              {entry.thru >= holeCount ? "Finished" : entry.thru === 0 ? "Not started" : `Hole ${onHole}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
