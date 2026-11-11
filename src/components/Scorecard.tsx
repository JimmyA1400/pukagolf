"use client";

import { useMemo, useState } from "react";

import { ScoreCell } from "@/components/ScoreCell";
import type { Score } from "@/lib/leaderboard";
import {
  buildScorecard,
  nextEnterableHole,
  type CoursePars,
  type ScorecardExtras,
  type ScorecardSegment,
} from "@/lib/scorecard";

type ScorecardProps = {
  /** Whose card this is. */
  playerName: string;
  pars: CoursePars;
  scores: readonly Score[];
  holeCount?: number;
  /** 10 for a back-nine week; the card shows holes 10–18. */
  startHole?: number;
  /**
   * Called when the scorer enters or corrects a hole. Absent for a read-only
   * view — a player looking at their own card, or anyone watching another group.
   *
   * Validation belongs to the caller: this passes every entry up so a refusal
   * can be explained, rather than dropping it silently.
   */
  onSubmit?: (hole: number, strokes: number) => void;
  /**
   * Unlocks every hole rather than only the next one due. For the admin, who
   * bypasses the sequential rule and may fill a gap.
   */
  allowAnyHole?: boolean;
  /**
   * Overrides the caption under the name. The default describes a scorer
   * keeping a card, which is wrong for the admin editing someone else's.
   */
  caption?: string;
  /** Yardage and stroke index per hole, when the course carries them. */
  extras?: ScorecardExtras;
  /**
   * Handicap strokes this player gets, by hole, shown as dots on the card
   * the way a printed card marks them. Absent when the week isn't net.
   */
  received?: Readonly<Record<number, number>>;
};

export function Scorecard({
  playerName,
  pars,
  scores,
  holeCount = 18,
  startHole = 1,
  onSubmit,
  allowAnyHole = false,
  caption,
  extras,
  received,
}: ScorecardProps) {
  const card = useMemo(
    () => buildScorecard(pars, scores, holeCount, extras, startHole),
    [pars, scores, holeCount, extras, startHole],
  );
  const nextHole = nextEnterableHole(card);
  const readOnly = !onSubmit;

  return (
    // An editable card is never left under the unsent bar (UnsentScores).
    <section data-keep-clear={onSubmit ? "" : undefined} className="border border-hairline bg-card">
      <header className="flex items-baseline justify-between gap-4 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h3 className="font-display text-base font-bold">{playerName}</h3>
          <p className="meta mt-0.5">
            {caption ?? (readOnly ? "Read only" : "You are keeping this card")}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <div
            className={`font-display text-2xl font-bold ${toParColor(card.toPar)}`}
          >
            {/* Nothing on the card yet is nothing to par, not level par. */}
            {card.thru === 0 ? "—" : card.toParLabel}
          </div>
          <p className="meta mt-0.5">
            {card.thru === 0
              ? "Not started"
              : card.complete
                ? `${card.strokesTotal} strokes`
                : `Thru ${card.thru}`}
          </p>
        </div>
      </header>

      <div className="space-y-4 p-4">
        {card.segments.map((segment) => (
          <SegmentTable
            key={segment.label}
            segment={segment}
            nextHole={nextHole}
            allowAnyHole={allowAnyHole}
            onSubmit={onSubmit}
            received={received}
          />
        ))}

        {card.segments.length > 1 && (
          <div className="flex justify-between border-t border-hairline pt-3 font-mono text-xs">
            <span className="text-ink-soft">
              Total &middot; par {card.parTotal}
            </span>
            <span className="font-bold tabular-nums">
              {card.thru === 0 ? "—" : card.strokesTotal}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function SegmentTable({
  segment,
  nextHole,
  allowAnyHole,
  onSubmit,
  received,
}: {
  segment: ScorecardSegment;
  nextHole: number | null;
  allowAnyHole: boolean;
  onSubmit?: (hole: number, strokes: number) => void;
  received?: Readonly<Record<number, number>>;
}) {
  return (
    // Nine columns fit a phone; the wrapper is here so an unusual hole count
    // scrolls rather than breaking the layout.
    <div className="-mx-1 overflow-x-auto px-1">
      {/*
        table-fixed keeps every column the same width whatever the cell holds,
        so an editable card and a read-only one line up — otherwise an empty
        input and a "—" placeholder size their columns differently.
      */}
      {/* No minimum width: a fixed one in rem grew with Sunlight's bigger
          type until the total fell off the right edge of a phone. */}
      <table className="w-full table-fixed border-separate border-spacing-0 text-center font-mono text-sm">
        <thead>
          <tr>
            <Th className="w-12 text-left">Hole</Th>
            {segment.cells.map((cell) => (
              <Th key={cell.hole}>{cell.hole}</Th>
            ))}
            {/* Wide enough for "Total" and a three-figure score, and no
                wider: every rem here comes out of the holes' boxes. No side
                padding: in the fallback font, "TOTAL" lost its L to it. */}
            <Th flush className="w-11 text-[0.65rem] tracking-tight">{segment.label}</Th>
          </tr>
        </thead>

        <tbody>
          {/* Only when the course actually carries distances for this tee. */}
          {segment.cells.some((cell) => cell.yards) && (
            <tr>
              <Td className="pr-1.5 text-left text-xs text-ink-soft">Yds</Td>
              {segment.cells.map((cell) => (
                <Td
                  key={cell.hole}
                  className="text-[0.7rem] text-ink-soft tabular-nums"
                >
                  {cell.yards ?? "–"}
                </Td>
              ))}
              <Td className="text-[0.7rem] font-medium tabular-nums">
                {segment.cells.reduce((sum, c) => sum + (c.yards ?? 0), 0) ||
                  "–"}
              </Td>
            </tr>
          )}

          {/* Bold throughout: par is the number every score is read against,
              so it anchors the rows around it. */}
          <tr>
            <Td className="pr-1.5 text-left text-xs font-bold">Par</Td>
            {segment.cells.map((cell) => (
              <Td key={cell.hole} className="font-bold tabular-nums">
                {cell.par}
              </Td>
            ))}
            <Td className="font-bold tabular-nums">{segment.parTotal}</Td>
          </tr>

          {/* Stroke index, hardest hole first. Only when the course is rated. */}
          {segment.cells.some((cell) => cell.strokeIndex !== null) && (
            <tr>
              <Td className="pr-1.5 text-left text-xs text-ink-soft">HCP</Td>
              {segment.cells.map((cell) => (
                <Td
                  key={cell.hole}
                  className="text-[0.7rem] text-ink-soft tabular-nums"
                >
                  {cell.strokeIndex ?? "–"}
                </Td>
              ))}
              {/* Nothing to total: stroke indexes are ranks, not amounts. */}
              <Td className="text-ink-soft">–</Td>
            </tr>
          )}

          {/* The boxes being filled in come before the rest of the card when
              the unsent bar picks an edge: once Enter had left the box, it
              sat over the row it had just said wasn't sent. */}
          <tr data-keep-clear={onSubmit ? "2" : undefined}>
            {/* Its own padding, a hair on the left and room on the right: in the
                fallback font the word ran up against hole 1's box. */}
            <Td flush className="py-1.5 pr-2 pl-0.5 text-left text-xs font-medium">Score</Td>
            {segment.cells.map((cell) => (
              // Flush: the cell's own padding took 9px of every box, which in
              // Sunlight left a digit half its room.
              <Td key={cell.hole} flush className="relative">
                {/* Read only, the dots have a line of their own above the
                    box: tucked into its corner they sat on a bogey box's
                    lines at 375px, and more so in Sunlight's bigger type. */}
                {!onSubmit && received && (
                  <span
                    aria-label={
                      (received[cell.hole] ?? 0) > 0
                        ? `${received[cell.hole]} handicap ${received[cell.hole] === 1 ? "stroke" : "strokes"}`
                        : undefined
                    }
                    title={(received[cell.hole] ?? 0) > 0 ? "Handicap stroke" : undefined}
                    data-stroke-dots
                    className="block h-2 pt-0.5 text-center text-[0.55rem] leading-[0.5rem] text-forest"
                  >
                    {"•".repeat(Math.min(received[cell.hole] ?? 0, 3))}
                  </span>
                )}
                {onSubmit && (received?.[cell.hole] ?? 0) > 0 && (
                  <span
                    aria-label={`${received![cell.hole]} handicap ${received![cell.hole] === 1 ? "stroke" : "strokes"}`}
                    title="Handicap stroke"
                    className="pointer-events-none absolute top-0 right-0.5 text-[0.55rem] leading-none text-forest"
                  >
                    {"•".repeat(Math.min(received![cell.hole], 3))}
                  </span>
                )}
                <HoleEntry
                  hole={cell.hole}
                  par={cell.par}
                  strokes={cell.strokes}
                  isNext={cell.hole === nextHole}
                  unlocked={allowAnyHole}
                  onSubmit={onSubmit}
                />
              </Td>
            ))}
            <Td className="font-bold tabular-nums">
              {segment.holesPlayed === 0 ? "—" : segment.strokesTotal}
            </Td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function HoleEntry({
  hole,
  par,
  strokes,
  isNext,
  unlocked,
  onSubmit,
}: {
  hole: number;
  par: number;
  strokes: number | null;
  isNext: boolean;
  unlocked: boolean;
  onSubmit?: (hole: number, strokes: number) => void;
}) {
  const [draft, setDraft] = useState("");

  if (!onSubmit) {
    return (
      // The handicap-stroke dots, if any, are on their own line above.
      <span className="flex items-center justify-center pt-0.5 pb-0.5">
        {/* No wider than its column: in Sunlight's bigger type the box
            outgrew it and met the "Score" label. */}
        <ScoreCell strokes={strokes} par={par} size="sm" className="max-w-full" />
      </span>
    );
  }

  const commit = () => {
    // An empty box is someone tabbing past, not an entry. Everything else goes
    // up for validation so a refusal can be explained.
    if (draft !== "") onSubmit(hole, Number(draft));
    setDraft("");
  };

  return (
    <input
      // A locked hole is one the sequential rule would reject: it is neither
      // already entered (correctable) nor the next one due.
      disabled={!unlocked && strokes === null && !isNext}
      value={draft || strokes?.toString() || ""}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 2))}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      inputMode="numeric"
      aria-label={`Hole ${hole}, par ${par}`}
      // No side padding: the box is the whole cell, about 23px a hole on a
      // phone in Sunlight's bigger type, and two figures need 19 of it.
      // Two figures a size down: a 10 in the fallback font, in Sunlight,
      // needed 24px of a 21px box.
      className={`w-full min-w-0 appearance-none bg-transparent px-0 py-1.5 text-center tabular-nums outline-none disabled:opacity-30 ${
        (draft || strokes?.toString() || "").length > 1 ? "text-xs" : ""
      } ${
        isNext ? "rounded-md ring-2 ring-forest" : ""
      } ${scoreColor(strokes, par)}`}
    />
  );
}

/** Under par reads clay red, as it does on the leaderboard. */
function toParColor(toPar: number): string {
  return toPar < 0 ? "text-clay" : "";
}

function scoreColor(strokes: number | null, par: number): string {
  if (strokes === null) return "text-ink-soft";

  return strokes - par < 0 ? "text-clay" : "";
}

function Th({
  children,
  className = "",
  flush = false,
}: {
  children?: React.ReactNode;
  className?: string;
  /** No side padding, for a column whose word needs all of it. */
  flush?: boolean;
}) {
  return (
    <th
      className={`border-b border-hairline ${flush ? "" : "px-1"} py-1.5 font-mono text-xs font-normal text-ink-soft ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
  flush = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** No padding: the cell's contents fill it. A "p-0" passed in can't undo px-1. */
  flush?: boolean;
}) {
  return (
    <td className={`border-b border-hairline/50 ${flush ? "" : "px-1 py-1.5"} ${className}`}>
      {children}
    </td>
  );
}
