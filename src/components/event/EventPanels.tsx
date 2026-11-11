"use client";

import { Panel } from "@/components/league/Panels";
import { ScoreCell } from "@/components/ScoreCell";
import { TeeSelect, useTeeSelection } from "@/components/TeeSelect";
import { teeOptions, yardageTotals } from "@/lib/yardage";
import { getFormat, teamHoles, type Entry } from "@/lib/formats";
import { formatToPar, type Score } from "@/lib/leaderboard";
import { playSkins } from "@/lib/skins";
import type { EventState } from "@/lib/useEvent";

/** Team names built from their members, since teams are rarely named. */
export function teamLabel(data: EventState, teamId: string): string {
  const team = data.teams.find((t) => t.id === teamId);
  if (!team) return "—";

  const names = team.memberIds
    .map((id) => data.players.find((p) => p.id === id)?.name ?? "?")
    .map((name) => name.split(" ")[0])
    .join(" & ");

  return names || team.name || "Team";
}

/** Per-hole team scores for every team, computed once and shared. */
function allTeamHoles(data: EventState) {
  return data.teams.map((team) => ({
    team,
    holes: teamHoles(
      data.event.format,
      data.scores as Entry[],
      team.id,
      team.memberIds,
      data.event.hole_count,
    ),
  }));
}

export function EventTeeSheet({ data }: { data: EventState }) {
  if (data.teeTimes.length === 0) {
    return (
      <Panel icon="⛳" title="Tee sheet" subtitle="No tee times set">
        <p className="py-2 font-mono text-sm text-ink-soft">
          The organiser hasn&apos;t set tee times for this outing.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      icon="⛳"
      title="Tee sheet"
      subtitle={`${data.teeTimes.length} tee time${
        data.teeTimes.length === 1 ? "" : "s"
      }`}
    >
      {data.teeTimes.map((slot) => {
        const players = slot.teamIds.flatMap(
          (id) => data.teams.find((t) => t.id === id)?.memberIds ?? [],
        );

        return (
          <div
            key={slot.id}
            className="flex items-center justify-between gap-3 border-b border-dashed border-hairline py-2.5 last:border-0"
          >
            <span className="min-w-0 font-display text-[0.95rem]">
              {slot.teamIds.map((id) => teamLabel(data, id)).join("  ·  ")}
              <span className="ml-2 font-mono text-xs text-ink-soft">
                {players.length} players
              </span>
            </span>

            <span className="shrink-0 bg-forest-deep px-2.5 py-1 font-mono text-xs text-cream">
              {slot.teeAt}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}

export function EventSkins({
  data,
  stake,
}: {
  data: EventState;
  stake: number;
}) {
  const pars = Object.fromEntries(data.holes.map((h) => [h.hole, h.par]));

  // Skins are team-vs-team. Each team's completed hole becomes one "score",
  // keyed by team id, so the existing carry logic applies unchanged.
  const asScores: Score[] = allTeamHoles(data).flatMap(({ team, holes }) =>
    holes
      .filter((h) => h.strokes !== null)
      .map((h) => ({ playerId: team.id, hole: h.hole, strokes: h.strokes! })),
  );

  const game = playSkins(
    asScores,
    data.teams.map((t) => t.id),
    { stake, pars },
  );

  return (
    <Panel
      icon="🏌"
      title="Skins"
      subtitle={`$${stake}/hole · carries on a tie`}
    >
      {game.holes.length === 0 ? (
        <p className="py-2 font-mono text-sm text-ink-soft">
          Nothing settled yet.
        </p>
      ) : (
        game.holes.map((hole) => (
          <div
            key={hole.hole}
            className="flex items-baseline justify-between gap-3 border-b border-dashed border-hairline py-2 last:border-0"
          >
            <span className="font-display text-[0.95rem]">
              Hole {hole.hole}
              {hole.result ? ` (${hole.result})` : ""}
            </span>
            <span className="shrink-0 font-mono text-sm font-bold text-clay">
              {hole.status === "won"
                ? `${teamLabel(data, hole.winnerId!)} — $${hole.pot}`
                : hole.status === "carried"
                  ? "carry"
                  : `$${hole.pot}`}
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}

export function EventWhosWhere({ data }: { data: EventState }) {
  const pars = Object.fromEntries(data.holes.map((h) => [h.hole, h.par]));
  const hasPars = data.holes.length > 0;

  const rows = allTeamHoles(data)
    .map(({ team, holes }) => {
      const played = holes.filter((h) => h.strokes !== null);
      const strokes = played.reduce((sum, h) => sum + h.strokes!, 0);
      const par = played.reduce((sum, h) => sum + (pars[h.hole] ?? 0), 0);

      return {
        teamId: team.id,
        thru: played.length,
        toPar: hasPars && played.length > 0 ? strokes - par : null,
        strokes,
      };
    })
    .sort((a, b) => b.thru - a.thru);

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const progress = (row.thru / data.event.hole_count) * 100;
        const onHole = Math.min(row.thru + 1, data.event.hole_count);

        return (
          <div
            key={row.teamId}
            className="flex items-center gap-3 border border-hairline bg-card px-4 py-3"
          >
            <span className="w-24 shrink-0 truncate font-display text-sm font-semibold">
              {teamLabel(data, row.teamId)}
            </span>

            <span
              className={`w-10 shrink-0 text-right font-mono text-sm font-bold tabular-nums ${
                row.toPar !== null && row.toPar < 0 ? "text-clay" : ""
              }`}
            >
              {row.thru === 0 ? "—" : (formatToPar(row.toPar) ?? row.strokes)}
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

            <span className="w-14 shrink-0 text-right font-mono text-xs text-ink-soft">
              {row.thru >= data.event.hole_count ? "Finished" : `Hole ${onHole}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The full grid, the way a paper card reads: a row per team, a column per hole.
 * Scrolls inside itself so it never widens the page.
 */
export function EventScorecardGrid({ data }: { data: EventState }) {
  const spec = getFormat(data.event.format);
  const holes = Array.from(
    { length: data.event.hole_count },
    (_, i) => i + 1,
  );
  const parByHole = Object.fromEntries(data.holes.map((h) => [h.hole, h.par]));
  const strokeIndexByHole = Object.fromEntries(
    data.holes.map((h) => [h.hole, h.strokeIndex]),
  );
  const rows = allTeamHoles(data);

  const options = teeOptions(data.holes, data.tees);
  const [tee, setTee] = useTeeSelection(
    // Scoped to the course so the choice survives moving around the event.
    `course:${data.event.course_id ?? data.event.id}`,
    options,
  );
  const yardsByHole = Object.fromEntries(
    data.holes.map((h) => [h.hole, tee ? (h.yardages?.[tee] ?? null) : null]),
  );
  const totals = yardageTotals(data.holes, tee);

  return (
    <>
      <TeeSelect options={options} value={tee} onChange={setTee} />

      <div className="-mx-1 overflow-x-auto px-1 pb-2">
      <table className="w-full min-w-[44rem] border-collapse text-left">
        <thead>
          <tr>
            <th className="min-w-[8rem] border-b border-hairline pb-2 font-mono text-xs font-normal tracking-wider text-ink-soft uppercase">
              {spec.kind === "solo" ? "Player" : "Team"}
            </th>
            {holes.map((hole) => (
              <th
                key={hole}
                className="w-9 border-b border-hairline pb-2 text-center font-mono text-xs font-normal text-ink-soft"
              >
                {hole}
              </th>
            ))}
            <th className="w-12 border-b border-hairline pb-2 text-right font-mono text-xs font-normal tracking-wider text-ink-soft uppercase">
              Tot
            </th>
          </tr>

          {tee && totals.total > 0 && (
            <tr>
              <th className="py-1 font-mono text-[0.65rem] font-normal text-ink-soft">
                Yards
              </th>
              {holes.map((hole) => (
                <th
                  key={hole}
                  className="py-1 text-center font-mono text-[0.65rem] font-normal text-ink-soft tabular-nums"
                >
                  {yardsByHole[hole] ?? "–"}
                </th>
              ))}
              <th className="py-1 text-right font-mono text-[0.65rem] font-normal text-ink-soft tabular-nums">
                {totals.total}
              </th>
            </tr>
          )}

          {/* Bold throughout: par is the number every score is read against,
              so it anchors the rows around it. */}
          <tr>
            <th className="py-1 font-mono text-[0.7rem] font-bold text-ink">
              Par
            </th>
            {holes.map((hole) => (
              <th
                key={hole}
                className="py-1 text-center font-mono text-[0.7rem] font-bold text-ink tabular-nums"
              >
                {parByHole[hole] ?? "–"}
              </th>
            ))}
            <th className="py-1 text-right font-mono text-[0.7rem] font-bold text-ink tabular-nums">
              {data.holes.reduce((sum, h) => sum + h.par, 0) || "–"}
            </th>
          </tr>

          {/* Stroke index, hardest hole first. Only when the course is rated. */}
          {data.holes.some((h) => h.strokeIndex !== null) && (
            <tr>
              <th className="py-1 font-mono text-[0.65rem] font-normal text-ink-soft">
                HCP
              </th>
              {holes.map((hole) => (
                <th
                  key={hole}
                  className="py-1 text-center font-mono text-[0.65rem] font-normal text-ink-soft tabular-nums"
                >
                  {strokeIndexByHole[hole] ?? "–"}
                </th>
              ))}
              {/* Stroke indexes are ranks, not amounts, so there is no total. */}
              <th className="py-1 text-right font-mono text-[0.65rem] font-normal text-ink-soft">
                –
              </th>
            </tr>
          )}
        </thead>

        <tbody>
          {rows.map(({ team, holes: teamRow }) => {
            const total = teamRow
              .filter((h) => h.strokes !== null)
              .reduce((sum, h) => sum + h.strokes!, 0);

            return (
              <tr key={team.id} className="border-b border-hairline/60">
                <td className="py-2 pr-3 font-display text-[0.95rem] font-semibold whitespace-nowrap">
                  {teamLabel(data, team.id)}
                </td>

                {teamRow.map((cell) => (
                  <td key={cell.hole} className="px-0 py-1 text-center">
                    <ScoreCell
                      strokes={cell.strokes}
                      par={parByHole[cell.hole]}
                    />
                  </td>
                ))}

                <td className="py-2 text-right font-mono text-sm font-bold tabular-nums">
                  {total || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>
    </>
  );
}
