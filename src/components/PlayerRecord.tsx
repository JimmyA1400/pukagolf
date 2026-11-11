"use client";

import { useState } from "react";

import { ScoreCell } from "@/components/ScoreCell";
import { formatHandicapIndex } from "@/lib/handicap-index";
import { roundHoles } from "@/lib/holes";
import { friendlyDate } from "@/lib/league-week";
import type { HandicapResult } from "@/lib/handicap";
import { stillPlaying, type PlayerStats, type RoundSummary } from "@/lib/usePlayerRounds";

/**
 * Why the index is still the self-reported one. A nine counts as a round:
 * it is made up to an 18-hole differential, as WHS does. A round with no
 * tee to rate it by doesn't count at all, and that is said, or six signed
 * nines read "3 more rounds" as if none had been played.
 */
export function handicapWait(needed: number, unrated: number): string {
  const more = `${needed} more ${needed === 1 ? "round" : "rounds"} (9 or 18 holes) to calculate.`;
  if (unrated === 0) return `Self-reported. ${more}`;
  return `Self-reported. ${more} ${unrated === 1 ? "1 round doesn’t" : `${unrated} rounds don’t`} count yet: there’s no tee on record to rate ${unrated === 1 ? "it" : "them"} by. Setting the usual tees on the profile lets them count.`;
}

/** The calculated index, with an honest label when it is not yet earned. */
export function HandicapCard({
  result,
  unrated = 0,
}: {
  result: HandicapResult;
  /** Finished rounds that can't count: no tee to rate them by. */
  unrated?: number;
}) {
  const provisional = result.status === "provisional";

  return (
    <div className="border border-hairline bg-card px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="meta">Handicap Index</p>
          <p className="font-display text-4xl font-bold">
            {formatHandicapIndex(result.index)}
          </p>
        </div>

        <div className="text-right">
          {provisional ? (
            <>
              <span className="border border-clay px-2 py-0.5 font-mono text-[0.65rem] tracking-wider text-clay uppercase">
                Provisional
              </span>
              <p className="mt-1.5 font-mono text-xs text-ink-soft">
                {handicapWait(result.roundsNeeded, unrated)}
              </p>
            </>
          ) : (
            <p className="font-mono text-xs text-ink-soft">
              Lowest {result.differentialsUsed} of{" "}
              {Math.min(result.roundsPosted, 20)} differentials
              <br />
              {result.roundsPosted} round
              {result.roundsPosted === 1 ? "" : "s"} posted
            </p>
          )}
        </div>
      </div>

      {result.simulatorRounds > 0 && (
        <p className="mt-3 border-t border-dashed border-hairline pt-2 font-mono text-xs text-ink-soft">
          {result.simulatorRounds} of these{" "}
          {result.simulatorRounds === 1 ? "was" : "were"} on a simulator
          {result.status === "calculated" &&
            (result.simulatorWeight === 0
              ? ", which the league leaves out of the index"
              : result.simulatorWeight < 1 &&
                `, counted at ${Math.round(result.simulatorWeight * 100)}% towards the index`)}
          .
        </p>
      )}
    </div>
  );
}

export function StatsBlock({ stats }: { stats: PlayerStats }) {
  return (
    <dl className="grid grid-cols-3 gap-3">
      <Stat
        label="Scoring avg"
        value={stats.scoringAverage?.toFixed(1) ?? "—"}
        note="Last 10"
      />
      <Stat
        label="Best round"
        value={
          stats.bestRound
            ? stats.bestRound.toPar !== null
              ? formatToPar(stats.bestRound.toPar)
              : String(stats.bestRound.gross)
            : "—"
        }
        note={stats.bestRound?.courseName ?? undefined}
      />
      <Stat
        label="Rounds"
        value={String(stats.roundsThisSeason)}
        note="This season"
      />
    </dl>
  );
}

/**
 * The last twenty rounds, newest first. Tapping one opens its card.
 *
 * Expanded inline rather than on its own page: the comparison a golfer wants is
 * against the rounds around it, and navigating away loses that.
 */
export function RecentRounds({ rounds }: { rounds: readonly RoundSummary[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (rounds.length === 0) {
    return (
      <p className="font-mono text-xs text-ink-soft">
        No rounds posted yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {rounds.slice(0, 20).map((round) => {
        const open = openId === round.roundId;

        return (
          <div key={round.roundId} className="border border-hairline bg-card">
            <button
              type="button"
              onClick={() => setOpenId(open ? null : round.roundId)}
              aria-expanded={open}
              className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-[0.95rem] font-semibold">
                  {round.courseName ?? round.name}
                </span>
                <span className="block font-mono text-xs text-ink-soft">
                  {friendlyDate(round.playedOn)}
                  {round.tee && ` · ${titleCase(round.tee)}`}
                  {/* This week's card, still being played: said, not passed off
                      as a short round or a finished one, and not counted
                      above until it's signed or the week is final. */}
                  {stillPlaying(round)
                    ? round.holesPlayed < round.holeCount
                      ? ` · in progress, ${round.holesPlayed} of ${round.holeCount} holes`
                      : " · in progress, not signed yet"
                    : round.holesPlayed < round.holeCount &&
                      ` · ${round.holesPlayed} of ${round.holeCount} holes`}
                  {round.isEvent && (
                    <span className="ml-1.5 border border-forest px-1 text-[0.6rem] tracking-wider text-forest uppercase">
                      Event
                    </span>
                  )}
                  {round.isSimulator && (
                    <span className="ml-1.5 border border-hairline px-1 text-[0.6rem] tracking-wider uppercase">
                      Sim
                    </span>
                  )}
                </span>
              </span>

              <span className="shrink-0 text-right">
                <span className="block font-display text-lg font-bold">
                  {round.gross}
                </span>
                <span
                  className={`block font-mono text-xs tabular-nums ${
                    round.toPar !== null && round.toPar < 0 ? "text-clay" : "text-ink-soft"
                  }`}
                >
                  {round.toPar !== null ? formatToPar(round.toPar) : "—"}
                </span>
              </span>

              <span className="w-14 shrink-0 text-right font-mono text-xs text-ink-soft">
                {round.differential !== null
                  ? round.differential.toFixed(1)
                  : "—"}
              </span>
            </button>

            {open && <RoundScorecard round={round} />}
          </div>
        );
      })}
    </div>
  );
}

/** The round's own card, using the same ScoreCell as live scoring. */
function RoundScorecard({ round }: { round: RoundSummary }) {
  const holes = roundHoles(round.holeCount, round.startHole ?? 1);
  // Par for the holes this round played, not the whole course.
  const par = holes.every((h) => round.pars[h] !== undefined)
    ? holes.reduce((sum, h) => sum + round.pars[h], 0)
    : null;

  return (
    <div className="border-t border-hairline px-4 py-3">
      {round.differential === null && (
        <p className="mb-2 font-mono text-xs text-ink-soft">
          No differential: this round&apos;s tee has no rating and slope.
        </p>
      )}

      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[38rem] border-collapse text-center">
          <thead>
            <tr>
              <th className="pb-1 text-left font-mono text-[0.65rem] font-normal text-ink-soft">
                Hole
              </th>
              {holes.map((hole) => (
                <th
                  key={hole}
                  className="pb-1 font-mono text-[0.65rem] font-normal text-ink-soft"
                >
                  {hole}
                </th>
              ))}
              <th className="pb-1 text-right font-mono text-[0.65rem] font-normal text-ink-soft">
                Tot
              </th>
            </tr>
          </thead>

          <tbody>
            <tr>
              <td className="text-left font-mono text-[0.7rem] font-bold">Par</td>
              {holes.map((hole) => (
                <td
                  key={hole}
                  className="font-mono text-[0.7rem] font-bold tabular-nums"
                >
                  {round.pars[hole] ?? "–"}
                </td>
              ))}
              <td className="text-right font-mono text-[0.7rem] font-bold tabular-nums">
                {par ?? "–"}
              </td>
            </tr>

            <tr>
              <td className="text-left font-mono text-[0.7rem]">Score</td>
              {holes.map((hole) => (
                <td key={hole} className="py-0.5">
                  <ScoreCell
                    strokes={round.scores[hole] ?? null}
                    par={round.pars[hole]}
                    size="sm"
                  />
                </td>
              ))}
              <td className="text-right font-mono text-sm font-bold tabular-nums">
                {round.gross}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatToPar(toPar: number): string {
  if (toPar === 0) return "E";

  return toPar > 0 ? `+${toPar}` : String(toPar);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="border border-hairline bg-card px-3 py-3">
      <dt className="meta">{label}</dt>
      <dd className="font-display text-xl font-bold">{value}</dd>
      {note && (
        <dd className="truncate font-mono text-[0.65rem] text-ink-soft">
          {note}
        </dd>
      )}
    </div>
  );
}
