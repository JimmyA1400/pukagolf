"use client";

import { useState } from "react";

import { getGame } from "@/lib/games";
import { formatToPar } from "@/lib/leaderboard";
import type { LeagueRules, StandingRow, Week } from "@/lib/standings";
import type { SeasonState } from "@/lib/useSeason";

/** "+2.5", "E", "-1" — to par as golfers read it, averages included. */
function toPar(value: number | null): string {
  return formatToPar(value) ?? "—";
}

/** The rules in a sentence or two, so nobody has to ask how points work. */
function describeRules(rules: LeagueRules): string {
  const parts = [
    `Points each week for completed cards: ${rules.points.join(", ")} for the top ${rules.points.length}, and ${rules.completionPoint} for finishing anywhere below. Ties share the higher points.`,
  ];

  if (rules.dropWorst > 0) {
    parts.push(
      `Each player's worst ${rules.dropWorst} ${rules.dropWorst === 1 ? "week is" : "weeks are"} dropped; a missed week counts as a zero.`,
    );
  }
  if (rules.minWeeks > 0) {
    parts.push(`It takes ${rules.minWeeks} ${rules.minWeeks === 1 ? "week" : "weeks"} to be ranked.`);
  }

  parts.push(
    rules.ranking === "gross"
      ? "Ranked on gross scores."
      : "Ranked net. A final week keeps each player's handicap index from when it was marked final, so a new index never re-ranks it; a week still being played uses today's. A player with no handicap index isn't ranked in a net week. A week on a course without stroke indexes, or one where nobody had a handicap index, is ranked gross, and says so.",
  );

  if (!rules.guestsScore) parts.push("Guests play alongside but don't take places or points.");

  return parts.join(" ");
}

/**
 * The season table: points by weekly finish, with the numbers behind them.
 */
export function SeasonStandings({
  state,
  viewerId,
  onRefresh,
  onYearChange,
}: {
  state: SeasonState;
  viewerId: string;
  onRefresh: () => void;
  onYearChange?: (year: number) => void;
}) {
  // Null follows the league's own rule, so the table opens on the one that
  // counts and the season doesn't have to have loaded to decide.
  const [chosen, setChosen] = useState<"net" | "gross" | null>(null);

  if (state.status === "loading") {
    return <p className="font-mono text-xs text-ink-soft">Loading the season…</p>;
  }

  if (state.status === "error") {
    return (
      <div className="space-y-2">
        <p role="alert" className="font-mono text-xs break-words text-clay">
          The season didn&apos;t load ({state.message}).
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="font-mono text-xs text-forest underline"
        >
          Try again
        </button>
      </div>
    );
  }

  const { season } = state;
  const { leagueSkins, rules, closed } = season;
  const ranking = chosen ?? rules.ranking;
  // The same cards scored the other way. Only a view: the league's own table
  // is the one its rules set, and the note below says so when they differ.
  const { standings, weeks } = ranking === "gross" ? season.gross : season.net;
  const nameOf = new Map(season.players.map((p) => [p.id, p.name]));
  const ranked = standings.filter((r) => r.qualified);
  const unranked = standings.filter((r) => !r.qualified && !r.noHandicap);
  const noHandicap = standings.filter((r) => r.noHandicap);
  const columns = leagueSkins ? 8 : 7;
  const counted = weeks.filter((w) => w.counts).length;
  // A live week in the table: the points aren't official yet, and say so.
  const provisional = !closed && weeks.some((w) => w.counts && w.provisional);
  const leaders = ranked.filter((r) => r.position === 1 && r.points > 0);
  const waitingNames = listNames(season.waiting.map((w) => w.name));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          {season.years.length > 1 && onYearChange ? (
            <select
              value={season.year}
              onChange={(e) => onYearChange(Number(e.target.value))}
              aria-label="Season"
              className="min-h-9 border border-hairline bg-cream px-2 font-mono text-xs"
            >
              {season.years.map((y) => (
                <option key={y} value={y}>
                  {y} season
                </option>
              ))}
            </select>
          ) : (
            <span className="meta">{season.year} season</span>
          )}
          <span className="meta">
            {counted} {counted === 1 ? "week" : "weeks"} counted
            {provisional && " · provisional"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RankingToggle value={ranking} onChange={setChosen} />
          <button
            type="button"
            onClick={onRefresh}
            className="font-mono text-xs text-forest underline"
          >
            Refresh
          </button>
        </div>
      </div>

      {ranking !== rules.ranking && (
        <p className="font-mono text-xs text-ink-soft">
          Showing {ranking}. The league&rsquo;s own table is {rules.ranking}, and
          that is what the season is decided on.
        </p>
      )}

      {closed && (
        <p className="border-2 border-forest bg-card px-4 py-3 font-display text-lg font-bold">
          Final standings
          {closed.championName && (
            <span className="block font-mono text-xs font-normal text-ink-soft">
              {season.year} champion: {closed.championName}
            </span>
          )}
        </p>
      )}

      {provisional && leaders.length > 0 && (
        <p className="border-2 border-dashed border-forest bg-card px-4 py-3 font-display text-lg font-bold">
          <span className="meta block">Current leader &middot; provisional</span>
          {leaders.map((l) => l.name).join(" & ")}, {leaders[0].points}{" "}
          {leaders[0].points === 1 ? "point" : "points"}
          <span className="block font-mono text-xs font-normal text-ink-soft">
            A week is still being played, so these points can change. They&rsquo;re
            official once the week is marked final.
          </span>
        </p>
      )}

      {season.waiting.length > 0 && !closed && (
        <p className="font-mono text-xs text-ink-soft">
          {waitingNames}{" "}
          {season.waiting.length === 1 ? "isn’t" : "aren’t"} in the table yet:{" "}
          {rules.standingsCount === "live"
            ? "a week counts once it’s being played."
            : "the league counts a week once it’s marked final."}
        </p>
      )}

      {standings.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">
          {season.waiting.length > 0
            ? "No week counts yet, so nobody is ranked."
            : "No scores this season yet. The table fills in as weeks are played."}
        </p>
      ) : (
        <div className="overflow-x-auto border border-hairline bg-card">
          {/* Fits a phone: the average and best columns wait for a wider screen. */}
          <table className="w-full font-mono text-sm tabular-nums">
            <thead>
              <tr className="border-b border-hairline text-left">
                <Th>Pos</Th>
                <Th wide>Player</Th>
                <Th right>Pts</Th>
                <Th right>Wks</Th>
                <Th right>Wins</Th>
                <Th right wideOnly>Avg</Th>
                <Th right wideOnly>Best</Th>
                {leagueSkins && <Th right>Skins</Th>}
              </tr>
            </thead>
            <tbody>
              {ranked.map((row) => (
                <Row key={row.playerId} row={row} viewerId={viewerId} leagueSkins={leagueSkins} />
              ))}
              {unranked.length > 0 && (
                <tr className="border-b border-hairline bg-sand">
                  <td colSpan={columns} className="meta px-3 py-1.5">
                    Not yet ranked: fewer than {rules.minWeeks} weeks
                  </td>
                </tr>
              )}
              {unranked.map((row) => (
                <Row key={row.playerId} row={row} viewerId={viewerId} leagueSkins={leagueSkins} />
              ))}
              {noHandicap.length > 0 && (
                <tr className="border-b border-hairline bg-sand">
                  <td colSpan={columns} className="meta px-3 py-1.5">
                    Played with no handicap index, so not ranked net. A final week keeps the
                    handicaps it was marked final with, so adding an index now counts from the
                    next week.
                  </td>
                </tr>
              )}
              {noHandicap.map((row) => (
                <Row key={row.playerId} row={row} viewerId={viewerId} leagueSkins={leagueSkins} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {weeks.length > 0 && (
        <section>
          <h3 className="meta mb-2">Week by week</h3>
          <ul className="border border-hairline bg-card px-4">
            {[...weeks].reverse().map((week) => {
              const winners = week.results.filter((r) => r.position === 1);
              const score = winners[0]
                ? getGame(week.game).rankedBy === "points"
                  ? `${winners[0].gamePoints ?? 0} pts`
                  : toPar(week.rankedBy === "net" ? winners[0].netToPar : winners[0].grossToPar)
                : null;

              return (
                <li
                  key={week.roundId}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-dashed border-hairline py-2 last:border-b-0"
                >
                  <span className="font-display text-[0.95rem]">
                    {week.name}
                    <span className="ml-2 font-mono text-xs text-ink-soft">
                      {week.playedOn}
                      {week.game !== "stroke" && ` · ${getGame(week.game).label.toLowerCase()}`}
                      {" · "}
                      {!week.counts
                        ? "rained out, doesn't count"
                        : week.provisional
                          ? `${rankedLabel(week)}, being played · provisional`
                          : rankedLabel(week)}
                    </span>
                  </span>
                  <span className="font-mono text-xs">
                    {winners.length === 0
                      ? week.provisional
                        ? "Nobody has finished yet"
                        : "Nobody finished"
                      : `${week.provisional ? "Leading: " : ""}${winners
                          .map((w) => nameOf.get(w.playerId) ?? "?")
                          .join(" & ")} ${score}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="font-mono text-xs text-ink-soft">{describeRules(rules)}</p>
    </div>
  );
}

/** "net", or "gross" with why, in a league that ranks net. */
function rankedLabel(week: Week): string {
  switch (week.grossBecause) {
    case "no_index":
      return "gross: nobody in it had a handicap index";
    case "no_stroke_indexes":
      return "gross: the course has no stroke indexes";
    case "one_ball":
      return "gross: one ball between the side";
    default:
      return week.rankedBy;
  }
}

/** "Week 2", "Week 2 and Week 3". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");

  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Net or gross, for the whole tab.
 *
 * One control, at the top: the table and the weeks below it are the same
 * season, and a net table beside gross weekly winners would be two of them on
 * one page.
 */
function RankingToggle({
  value,
  onChange,
}: {
  value: "net" | "gross";
  onChange: (next: "net" | "gross") => void;
}) {
  return (
    <div
      role="group"
      aria-label="Season scoring"
      className="flex border border-hairline font-mono text-xs tracking-wider uppercase"
    >
      {(["gross", "net"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`min-h-9 px-3 ${
            value === option ? "bg-forest-deep text-cream" : "bg-card"
          }`}
        >
          {option === "gross" ? "Gross" : "Net"}
        </button>
      ))}
    </div>
  );
}

function Row({
  row,
  viewerId,
  leagueSkins,
}: {
  row: StandingRow;
  viewerId: string;
  leagueSkins: boolean;
}) {
  return (
    <tr
      className={`border-b border-dashed border-hairline last:border-b-0 ${
        row.playerId === viewerId ? "bg-highlight" : ""
      }`}
    >
      <Td>{row.qualified ? row.position : "—"}</Td>
      <Td wide>
        <span className="font-display text-base font-bold">{row.name}</span>
        {row.noHandicap && (
          <span className="block font-mono text-[0.7rem] text-ink-soft">No handicap · not ranked</span>
        )}
      </Td>
      <Td right bold>
        {row.points}
      </Td>
      <Td right>
        {row.completed}/{row.weeksPlayed}
      </Td>
      <Td right>{row.wins}</Td>
      <Td right wideOnly>{toPar(row.average)}</Td>
      <Td right wideOnly>{toPar(row.best)}</Td>
      {leagueSkins && <Td right>${row.skinsWon}</Td>}
    </tr>
  );
}

function Th({
  children,
  right,
  wide,
  wideOnly,
}: {
  children: React.ReactNode;
  right?: boolean;
  wide?: boolean;
  /** Left out on a phone, so the table fits without scrolling sideways. */
  wideOnly?: boolean;
}) {
  return (
    <th
      className={`meta px-2 py-2 font-normal sm:px-3 ${right ? "text-right" : ""} ${
        wide ? "w-full" : ""
      } ${wideOnly ? "hidden sm:table-cell" : ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  wide,
  bold,
  wideOnly,
}: {
  children: React.ReactNode;
  right?: boolean;
  wide?: boolean;
  bold?: boolean;
  wideOnly?: boolean;
}) {
  return (
    <td
      className={`px-2 py-2 sm:px-3 ${right ? "text-right" : ""} ${wide ? "w-full" : ""} ${
        bold ? "font-bold" : ""
      } ${wideOnly ? "hidden sm:table-cell" : ""}`}
    >
      {children}
    </td>
  );
}
