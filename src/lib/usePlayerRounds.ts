"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  adjustedGross,
  differential,
  indexFromDifferentials,
  nineHoleDifferential,
  nineHoleRating,
  type HandicapResult,
} from "./handicap";
import { roundHoles } from "./holes";
import { playingHandicap, receivedStrokes } from "./net";
import { createClient } from "./supabase/client";

export type PlayerRound = {
  roundId: string;
  name: string;
  playedOn: string;
  status: "setup" | "live" | "final";
  courseName: string | null;
  holeCount: number;
  /** 10 for a back-nine week; missing means hole 1. */
  startHole?: number;
  /** Played indoors. Counts at the league's simulator weight. */
  isSimulator?: boolean;
  /** From a league event rather than a weekly round. */
  isEvent?: boolean;
  /** The player's card is signed off, though the week is still live. */
  signed?: boolean;
  tee: string | null;
  courseRating: number | null;
  slope: number | null;
  coursePar: number | null;
  scores: Record<string, number>;
  pars: Record<string, number>;
  strokeIndexes: Record<string, number>;
};

export type RoundSummary = PlayerRound & {
  gross: number;
  /** Null when the course has no par data to compare against. */
  toPar: number | null;
  /** Null when the tee was never rated, so no differential is possible. */
  differential: number | null;
  holesPlayed: number;
};

export type PlayerStats = {
  /** Mean gross over the last ten completed rounds. */
  scoringAverage: number | null;
  bestRound: RoundSummary | null;
  roundsThisSeason: number;
  /**
   * Finished rounds with no rating to measure them by: no tee recorded and
   * no tee preference, on a course with more than one. They can't count
   * toward the handicap, and the profile says so.
   */
  unratedRounds: number;
};

/**
 * A card still being played: its week is live and the card isn't signed.
 * Shown as "in progress", and kept out of the index and the numbers until
 * it is signed or the week is final.
 */
export function stillPlaying(round: Pick<PlayerRound, "status" | "signed">): boolean {
  return round.status !== "final" && !round.signed;
}

/** The numbers above the rounds, from finished cards only. */
export function playerStats(
  summaries: readonly RoundSummary[],
  thisYear: number = new Date().getFullYear(),
): PlayerStats {
  const complete = summaries.filter((s) => s.holesPlayed === s.holeCount && !stillPlaying(s));
  const lastTen = complete.slice(0, 10);

  return {
    scoringAverage:
      lastTen.length > 0
        ? Math.round((lastTen.reduce((sum, r) => sum + r.gross, 0) / lastTen.length) * 10) / 10
        : null,
    bestRound:
      complete.length > 0
        ? complete.reduce((best, r) =>
            r.toPar !== null && (best.toPar === null || r.toPar < best.toPar) ? r : best,
          )
        : null,
    roundsThisSeason: complete.filter((r) => new Date(r.playedOn).getFullYear() === thisYear).length,
    unratedRounds: complete.filter((r) => r.differential === null).length,
  };
}

/**
 * Only rounds where every hole was posted count toward a handicap.
 *
 * A nine-hole card left half-finished would otherwise look like a very low
 * score and drag the index down.
 */
function isComplete(round: PlayerRound): boolean {
  return Object.keys(round.scores).length === round.holeCount;
}

export function summarise(
  round: PlayerRound,
  selfReportedIndex: number | null,
): RoundSummary {
  const holesPlayed = Object.keys(round.scores).length;
  const gross = Object.values(round.scores).reduce((a, b) => a + b, 0);

  const parsPlayed = Object.keys(round.scores).reduce(
    (sum, hole) => sum + (round.pars[hole] ?? 0),
    0,
  );

  const hasRating = round.courseRating !== null && round.slope !== null;

  // Net double bogey needs a stroke allocation, which needs an index. The
  // self-reported one is used until a calculated one exists — that is what WHS
  // does for a player's first rounds too.
  // The same strokes the leaderboard gives: a nine gets a nine's worth, on
  // that nine's hardest holes.
  const handicap =
    hasRating && round.coursePar
      ? playingHandicap({
          index: selfReportedIndex,
          tee: { courseRating: round.courseRating, slope: round.slope },
          coursePar: round.coursePar,
          holeCount: round.holeCount,
        })
      : null;
  const received =
    handicap !== null
      ? (receivedStrokes(
          handicap,
          Object.fromEntries(
            Object.entries(round.strokeIndexes).map(([h, i]) => [Number(h), i]),
          ),
          roundHoles(round.holeCount, round.startHole ?? 1),
        ) ?? {})
      : {};

  const adjusted = adjustedGross(
    Object.fromEntries(
      Object.entries(round.scores).map(([h, s]) => [Number(h), s]),
    ),
    Object.fromEntries(
      Object.entries(round.pars).map(([h, p]) => [Number(h), p]),
    ),
    received,
  );

  return {
    ...round,
    gross,
    toPar: parsPlayed > 0 ? gross - parsPlayed : null,
    // Only complete rounds count: a half-finished card would look like a very
    // low score and drag the index down.
    // Nine holes are measured against the nine's rating and made up to 18
    // with what the player would be expected to score on the other nine.
    differential:
      hasRating && isComplete(round)
        ? round.holeCount === 9 && round.coursePar
          ? nineHoleDifferential(
              adjusted,
              nineHoleRating(round.courseRating!, round.coursePar).rating,
              round.slope!,
              selfReportedIndex,
            )
          : differential(adjusted, round.courseRating!, round.slope!)
        : null,
    holesPlayed,
  };
}

/** A player's rounds, calculated index and headline stats. */
export function usePlayerRounds(
  playerId: string | null,
  selfReportedIndex: number | null,
) {
  const supabase = useMemo(() => createClient(), []);
  const [rounds, setRounds] = useState<PlayerRound[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What a simulator round is worth here. 1 until the league says otherwise,
  // so a slow settings read can't quietly discount somebody's winter.
  const [simulatorWeight, setSimulatorWeight] = useState(1);

  const load = useCallback(async () => {
    if (!playerId) return;

    const [{ data, error: rpcError }, events, weeks, settings, signedCards] = await Promise.all([
      supabase.rpc("player_rounds", { in_player_id: playerId }),
      // League events they played in their own ball. The function decides
      // which qualify; see 0043_event_tees.sql.
      supabase.rpc("player_event_rounds", { in_player_id: playerId }),
      // Which weeks were indoors. Read alongside rather than folded into
      // player_rounds, so that function stays exactly as it is.
      supabase.from("rounds").select("id, is_simulator"),
      // Site-wide: a handicap is one number wherever the rounds were played.
      supabase.rpc("site_settings"),
      // Cards signed off in a week still live count as finished.
      supabase.from("card_locks").select("round_id, how").eq("player_id", playerId),
    ]);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    const indoors = new Set(
      (weeks.data ?? []).filter((w) => w.is_simulator).map((w) => w.id),
    );
    const signed = new Set(
      (signedCards.data ?? []).filter((l) => l.how !== "admin").map((l) => l.round_id),
    );

    setSimulatorWeight((settings.data as { simulatorWeight?: number } | null)?.simulatorWeight ?? 1);
    setRounds(
      [
        ...(data as unknown as PlayerRound[]).map((r) => ({
          ...r,
          isSimulator: indoors.has(r.roundId),
          signed: signed.has(r.roundId),
        })),
        // Events already carry their own simulator flag.
        ...((events.data as unknown as PlayerRound[] | null) ?? []),
      ].sort((a, b) => b.playedOn.localeCompare(a.playedOn)),
    );
  }, [supabase, playerId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const summaries = useMemo(
    () => (rounds ?? []).map((r) => summarise(r, selfReportedIndex)),
    [rounds, selfReportedIndex],
  );

  const index: HandicapResult = useMemo(
    () =>
      indexFromDifferentials(
        summaries
          .filter((s) => s.differential !== null && !stillPlaying(s))
          .map((s) => ({
            differential: s.differential!,
            playedOn: s.playedOn,
            simulator: s.isSimulator,
          })),
        selfReportedIndex,
        { simulatorWeight },
      ),
    [summaries, selfReportedIndex, simulatorWeight],
  );

  const stats: PlayerStats = useMemo(() => playerStats(summaries), [summaries]);

  return { rounds: summaries, index, stats, error, reload: load };
}
