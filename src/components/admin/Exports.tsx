"use client";

import Link from "next/link";

import { toCsv, type Cell } from "@/lib/csv";
import { useSeason } from "@/lib/useSeason";
import { useClub } from "@/lib/club";

/** Hand the browser a CSV to save. A byte-order mark so Excel reads UTF-8. */
function download(filename: string, rows: Cell[][]) {
  const blob = new Blob(["﻿", toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The season as spreadsheets, and this week on paper.
 *
 * Built in the browser from the same season data the Standings tab uses, so
 * a download always matches what's on screen, rules included.
 */
export function Exports() {
  const { club, href, league } = useClub();
  const { state } = useSeason();

  if (state.status !== "ready") {
    return (
      <p className="font-mono text-xs text-ink-soft">
        {state.status === "error" ? state.message : "Loading the season…"}
      </p>
    );
  }

  const { season } = state;
  const nameOf = new Map(season.players.map((p) => [p.id, p.name]));
  // The club and league in the name, so one league's file doesn't replace
  // another's in Downloads: practice-ridge-thursday-2026-scores.csv.
  const prefix = `${club.slug}-${league?.slug ?? "league"}-${season.year}`;

  const standings = () =>
    download(`${prefix}-standings.csv`, [
      ["Position", "Player", "Points", "Weeks played", "Completed", "Wins", "Average to par", "Best to par", "Skins won", "Ranked"],
      ...season.standings.map((r) => [
        r.qualified ? r.position : null,
        r.name,
        r.points,
        r.weeksPlayed,
        r.completed,
        r.wins,
        r.average,
        r.best,
        r.skinsWon,
        r.qualified,
      ]),
    ]);

  const results = () =>
    download(`${prefix}-week-results.csv`, [
      ["Week", "Date", "Counts", "Ranked by", "Player", "Position", "Points", "Gross to par", "Net to par", "Skins won", "Finished"],
      ...season.weeks.flatMap((w) =>
        w.results.map((r) => [
          w.name,
          w.playedOn,
          w.counts,
          w.rankedBy,
          nameOf.get(r.playerId) ?? "Former player",
          r.position,
          r.points,
          r.grossToPar,
          r.netToPar,
          r.skinsWon,
          r.complete,
        ]),
      ),
    ]);

  const scores = () =>
    download(`${prefix}-scores.csv`, [
      ["Week", "Date", "Player", "Hole", "Par", "Strokes"],
      ...season.rounds.flatMap((round) =>
        [...round.scores]
          .sort((a, b) => a.playerId.localeCompare(b.playerId) || a.hole - b.hole)
          .map((s) => [
            round.name,
            round.playedOn,
            nameOf.get(s.playerId) ?? "Former player",
            s.hole,
            round.pars[s.hole] ?? null,
            s.strokes,
          ]),
      ),
    ]);

  // The standings files need a week that counts; the scores are there to
  // download the moment anyone has posted one.
  const empty = season.weeks.length === 0;
  const noScores = season.rounds.every((round) => round.scores.length === 0);

  return (
    <div className="space-y-3 border border-hairline bg-card p-4">
      <p className="font-mono text-xs text-ink-soft">
        Spreadsheets of the {season.year} season, for Excel, Numbers or Google
        Sheets.
      </p>
      <div className="flex flex-wrap gap-2">
        <ExportButton onClick={standings} disabled={empty}>
          Standings
        </ExportButton>
        <ExportButton onClick={results} disabled={empty}>
          Week by week
        </ExportButton>
        <ExportButton onClick={scores} disabled={noScores}>
          Every score
        </ExportButton>
      </div>
      {empty && (
        <p className="font-mono text-xs text-ink-soft">
          {noScores
            ? "Nothing to export until a week has scores."
            : `Every score can be downloaded now. The standings and week-by-week files fill in once a week counts${
                season.rules.standingsCount === "live" ? "" : ", which is when it’s marked final"
              }.`}
        </p>
      )}
      <p className="border-t border-dashed border-hairline pt-3 font-mono text-xs">
        <Link href={href("/league/print")} className="text-forest underline">
          Print this week&apos;s tee sheet and scorecards
        </Link>
      </p>
    </div>
  );
}

function ExportButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="min-h-10 border border-forest px-4 font-mono text-xs tracking-wider text-forest uppercase disabled:opacity-40"
    >
      {children} (CSV)
    </button>
  );
}
