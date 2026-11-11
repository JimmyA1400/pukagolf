"use client";

import { roundHoles } from "@/lib/holes";
import type { Score } from "@/lib/leaderboard";
import { playSkins } from "@/lib/skins";
import type { SeasonState } from "@/lib/useSeason";

type BracketGroup = { id: string; label: string; playerIds: string[] };

/**
 * The skins bracket: every group's game hole by hole, who took each skin and
 * what it was worth, with carries shown, and the season's winnings.
 *
 * Skins are played within each group, the same way the live pot on the 19th
 * Hole tab settles them, so the two can't disagree.
 */
export function SkinsBracket({
  groups,
  players,
  scores,
  pars,
  holeCount,
  startHole = 1,
  stake,
  weekEnabled,
  season,
}: {
  groups: readonly BracketGroup[];
  players: readonly { id: string; name: string }[];
  scores: readonly Score[];
  pars: Readonly<Record<number, number>>;
  holeCount: number;
  /** 10 for a back-nine week. */
  startHole?: number;
  stake: number;
  weekEnabled: boolean;
  season: SeasonState;
}) {
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? "?";
  const short = (id: string) => nameOf(id).split(" ")[0];
  const holes = roundHoles(holeCount, startHole);

  const seasonSkins =
    season.status === "ready"
      ? season.season.standings
          .filter((row) => row.skinsWon > 0)
          .sort((a, b) => b.skinsWon - a.skinsWon)
      : [];

  return (
    <div className="space-y-6">
      {!weekEnabled ? (
        <p className="border border-hairline bg-card px-4 py-3 font-mono text-xs text-ink-soft">
          Skins are off this week. An admin can turn them on from the 19th Hole
          tab.
        </p>
      ) : stake <= 0 ? (
        <p className="border border-hairline bg-card px-4 py-3 font-mono text-xs text-ink-soft">
          No stake set for this week, so there are no skins to win.
        </p>
      ) : groups.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">
          No groups yet, so no skins games.
        </p>
      ) : (
        groups.map((group) => {
          if (group.playerIds.length < 2) return null;

          const game = playSkins(scores, group.playerIds, { stake, pars, holeCount, startHole });
          const byHole = new Map(game.holes.map((h) => [h.hole, h]));
          const strokes = new Map(
            scores
              .filter((s) => group.playerIds.includes(s.playerId))
              .map((s) => [`${s.playerId}:${s.hole}`, s.strokes]),
          );
          const paid = Object.entries(game.winnings)
            .filter(([, amount]) => amount > 0)
            .sort((a, b) => b[1] - a[1]);

          return (
            <section key={group.id}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display text-lg font-bold">{group.label}</h3>
                <span className="meta">
                  ${stake} a hole{game.carrying > 0 && ` · $${game.carrying} carrying`}
                </span>
              </div>

              <div className="overflow-x-auto border border-hairline bg-card">
                <table className="font-mono text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-hairline">
                      <th className="meta sticky left-0 bg-card px-3 py-2 text-left font-normal">
                        Hole
                      </th>
                      {holes.map((hole) => (
                        <th key={hole} className="meta px-2 py-2 text-center font-normal">
                          {hole}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.playerIds.map((id) => (
                      <tr key={id} className="border-b border-dashed border-hairline">
                        <td className="sticky left-0 bg-card px-3 py-1.5 font-display text-sm whitespace-nowrap">
                          {short(id)}
                        </td>
                        {holes.map((hole) => {
                          const value = strokes.get(`${id}:${hole}`);
                          const won = byHole.get(hole)?.winnerId === id;

                          return (
                            <td key={hole} className="px-1 py-1 text-center">
                              <span
                                className={`inline-flex h-6 w-6 items-center justify-center ${
                                  won ? "bg-forest-deep font-bold text-cream" : ""
                                }`}
                                aria-label={won ? `${nameOf(id)} won hole ${hole}` : undefined}
                              >
                                {value ?? "·"}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}

                    <tr>
                      <td className="meta sticky left-0 bg-card px-3 py-2">Skin</td>
                      {holes.map((hole) => {
                        const h = byHole.get(hole);

                        return (
                          <td key={hole} className="px-1 py-2 text-center whitespace-nowrap">
                            {!h ? (
                              ""
                            ) : h.status === "won" ? (
                              <span className="font-bold text-forest">${h.pot}</span>
                            ) : h.status === "carried" ? (
                              <span className="text-clay" title="Tied, so it carries">
                                →
                              </span>
                            ) : (
                              <span className="text-ink-soft">…</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>

              <p className="mt-2 font-mono text-xs">
                {paid.length === 0
                  ? "No skins won yet."
                  : paid.map(([id, amount]) => `${nameOf(id)} $${amount}`).join(" · ")}
              </p>
            </section>
          );
        })
      )}

      <section>
        <h3 className="meta mb-2">Season skins</h3>
        {season.status === "loading" ? (
          <p className="font-mono text-xs text-ink-soft">Loading…</p>
        ) : season.status === "error" ? (
          <p className="font-mono text-xs text-ink-soft">
            The season didn&apos;t load. Try again from the Standings tab.
          </p>
        ) : seasonSkins.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">
            Nobody has won a skin this season yet.
          </p>
        ) : (
          <ul className="border border-hairline bg-card px-4">
            {seasonSkins.map((row) => (
              <li
                key={row.playerId}
                className="flex items-baseline justify-between gap-2 border-b border-dashed border-hairline py-2 last:border-b-0"
              >
                <span className="font-display text-[0.95rem]">{row.name}</span>
                <span className="font-mono text-sm font-bold tabular-nums">${row.skinsWon}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
