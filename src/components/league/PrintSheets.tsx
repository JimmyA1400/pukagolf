"use client";

import Link from "next/link";
import { useState } from "react";

import { getGame } from "@/lib/games";
import { holesLabel, roundHoles } from "@/lib/holes";
import { useLiveRound } from "@/lib/useLiveRound";
import { useClub } from "@/lib/club";
import { clubClock } from "@/lib/club-time";
import { weekNet } from "@/lib/week-net";

type Column = { key: string; label: string; holes: number[]; hole?: number };

/**
 * This week's tee sheet and a scorecard for each group, laid out for paper:
 * for the clubhouse board, a starter, or a group whose phones have died.
 * Blank cards by default, or with the scores so far. Everything that isn't
 * the sheet is hidden when printing.
 */
export function PrintSheets() {
  const { club, href } = useClub();
  const { state } = useLiveRound();
  const [withScores, setWithScores] = useState(false);

  if (state.status === "loading") {
    return <p className="p-8 font-mono text-sm text-ink-soft">Loading…</p>;
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="p-8 font-mono text-sm text-clay">
        {state.message}
      </p>
    );
  }

  const { data } = state;
  const holes = roundHoles(data.course.holeCount, data.course.startHole);
  const front = holes.filter((h) => h <= 9);
  const back = holes.filter((h) => h > 9);
  // Out and In columns only when the round crosses the turn.
  const split = front.length > 0 && back.length > 0;

  const columns: Column[] = [
    ...front.map((h) => ({ key: `h${h}`, label: String(h), holes: [h], hole: h })),
    ...(split ? [{ key: "out", label: "Out", holes: front }] : []),
    ...back.map((h) => ({ key: `h${h}`, label: String(h), holes: [h], hole: h })),
    ...(split ? [{ key: "in", label: "In", holes: back }] : []),
    { key: "total", label: "Tot", holes },
  ];

  const nameOf = (id: string) => data.players.find((p) => p.id === id)?.full_name ?? "?";
  const par = (h: number) => data.pars[h] ?? 0;
  const strokeIndex = new Map(data.holes.map((h) => [h.hole, h.strokeIndex]));
  const rated = holes.some((h) => strokeIndex.get(h) != null);
  const strokes = new Map(data.scores.map((s) => [`${s.playerId}:${s.hole}`, s.strokes]));
  const keptBy = (id: string) => data.assignments.find((a) => a.scoredId === id)?.scorerId;
  // Course handicaps and stroke holes, as a printed card carries them.
  const net = weekNet(data);
  const gets = (id: string, hole: number) => net.received[id]?.[hole] ?? 0;

  /** A segment's total, only once every hole in it has a score. */
  const total = (id: string, list: number[]) => {
    let sum = 0;
    for (const h of list) {
      const value = strokes.get(`${id}:${h}`);
      if (value === undefined) return null;
      sum += value;
    }
    return sum;
  };

  const time = (iso: string) => clubClock(iso, club.timeZone);
  const day = new Date(`${data.round.played_on}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const coursePar = holes.reduce((sum, h) => sum + par(h), 0);

  const cellClass = (column: Column) =>
    `border border-rule py-1 ${column.hole === undefined ? "bg-sand font-bold" : ""}`;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-5 sm:p-8 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={href("/league")} className="font-mono text-xs underline">
          ← The league
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 font-mono text-xs">
            <input
              type="checkbox"
              checked={withScores}
              onChange={(e) => setWithScores(e.target.checked)}
              className="accent-forest"
            />
            Include scores so far
          </label>
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-10 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase"
          >
            Print
          </button>
        </div>
      </div>

      <header className="border-b-2 border-rule pb-2">
        <h1 className="font-display text-2xl font-bold">{data.round.name}</h1>
        <p className="font-mono text-xs">
          {day} · {data.course.name} · Par {coursePar} ·{" "}
          {holesLabel(data.course.holeCount, data.course.startHole)}
          {data.round.game !== "stroke" && ` · ${getGame(data.round.game).label}`}
        </p>
      </header>

      <section className="break-inside-avoid">
        <h2 className="section-head mb-2 pb-1 text-lg">Tee sheet</h2>
        {data.groups.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">No groups yet.</p>
        ) : (
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="border-b border-rule text-left">
                <th className="py-1 pr-3 font-normal">Group</th>
                <th className="py-1 pr-3 font-normal">Tee time</th>
                <th className="py-1 font-normal">Players</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((group, i) => (
                <tr key={group.id} className="border-b border-hairline align-top">
                  <td className="py-1.5 pr-3">{i + 1}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{time(group.teeAt)}</td>
                  <td className="py-1.5">{group.playerIds.map(nameOf).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {data.groups.map((group, i) => (
        <section key={group.id} className="break-inside-avoid">
          <h2 className="mb-1 font-display text-lg font-bold">
            Group {i + 1} · {time(group.teeAt)}
          </h2>
          <div className="overflow-x-auto print:overflow-visible">
            <table className="w-full min-w-[40rem] table-fixed border-collapse text-center font-mono text-xs print:min-w-0">
              <thead>
                <tr>
                  <th className="w-36 border border-rule px-1 py-1 text-left font-normal">Hole</th>
                  {columns.map((c) => (
                    <th key={c.key} className={`${cellClass(c)} font-normal`}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border border-rule px-1 py-1 text-left font-bold">Par</td>
                  {columns.map((c) => (
                    <td key={c.key} className={`${cellClass(c)} font-bold`}>
                      {c.holes.reduce((sum, h) => sum + par(h), 0)}
                    </td>
                  ))}
                </tr>
                {rated && (
                  <tr>
                    <td className="border border-rule px-1 py-1 text-left text-ink-soft">SI</td>
                    {columns.map((c) => (
                      <td key={c.key} className={`${cellClass(c)} text-ink-soft`}>
                        {c.hole !== undefined ? (strokeIndex.get(c.hole) ?? "") : ""}
                      </td>
                    ))}
                  </tr>
                )}
                {group.playerIds.map((id) => {
                  const scorer = keptBy(id);

                  return (
                    <tr key={id} className="h-10">
                      <td className="border border-rule px-1 text-left">
                        <span className="block truncate font-display text-sm">
                          {nameOf(id)}
                          {net.available && id in net.handicaps && (
                            <span className="font-mono text-[0.65rem]"> ({net.handicaps[id]})</span>
                          )}
                        </span>
                        {scorer && (
                          <span className="block truncate text-[0.6rem] text-ink-soft">
                            Kept by {nameOf(scorer)}
                          </span>
                        )}
                      </td>
                      {columns.map((c) => (
                        <td key={c.key} className={`relative ${cellClass(c)}`}>
                          {c.hole !== undefined && gets(id, c.hole) > 0 && (
                            <span
                              aria-label={`${gets(id, c.hole)} handicap ${gets(id, c.hole) === 1 ? "stroke" : "strokes"}`}
                              className="absolute top-0 right-0.5 text-[0.6rem] leading-none"
                            >
                              {"\u2022".repeat(Math.min(gets(id, c.hole), 3))}
                            </span>
                          )}
                          {!withScores
                            ? ""
                            : c.hole !== undefined
                              ? (strokes.get(`${id}:${c.hole}`) ?? "")
                              : (total(id, c.holes) ?? "")}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 font-mono text-[0.65rem] text-ink-soft">
            {net.available &&
              "Course handicap beside each name; a dot is a handicap stroke on that hole. "}
            Scorer ______________________ Attested ______________________
          </p>
        </section>
      ))}
    </main>
  );
}
