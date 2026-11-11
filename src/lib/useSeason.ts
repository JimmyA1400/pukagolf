"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_RULES,
  scoreWeek,
  seasonStandings,
  weekCounts,
  type LeagueRules,
  type SeasonPlayer,
  type SeasonRound,
  type StandingRow,
  type Week,
} from "./standings";
import { useClub } from "./club";
import { createClient } from "./supabase/client";

export type ClosedSeason = {
  closedAt: string;
  championId: string | null;
  championName: string | null;
};

/** A season scored one way, net or gross. */
export type Ranked = {
  weeks: Week[];
  standings: StandingRow[];
};

export type Season = {
  year: number;
  leagueSkins: boolean;
  rules: LeagueRules;
  /** Every year with a week in it, newest first, for the season picker. */
  years: number[];
  /** Set once the owner has closed the season. */
  closed: ClosedSeason | null;
  players: SeasonPlayer[];
  rounds: SeasonRound[];
  /** Weeks with scores that don't count yet: being played, or being set up. */
  waiting: { id: string; name: string; status: string }[];
  /** A week in the table is still being played, so the points aren't official. */
  provisional: boolean;
  /** The league's own table, under the ranking its rules set. */
  weeks: Week[];
  standings: StandingRow[];
  /**
   * The same season scored both ways, so the Standings tab can show either
   * without asking the database again. A week the course can't rank net is
   * still gross in the net table, and says so — see scoreWeek.
   */
  net: Ranked;
  gross: Ranked;
};

export type SeasonState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; season: Season };

/** What league_season() returns; the newer fields may be missing. */
type RawSeason = {
  year: number;
  leagueSkins: boolean;
  rules?: Partial<LeagueRules>;
  years?: number[];
  closed?: ClosedSeason | null;
  players: SeasonPlayer[];
  rounds: SeasonRound[];
};

/**
 * A whole season, scored.
 *
 * league_season() hands over the raw weeks and the league's rules in one call,
 * and every rule is applied here, by the same functions the live leaderboard
 * uses, so the standings can't disagree with what players saw on the day.
 */
export function useSeason(year?: number) {
  const supabase = useMemo(() => createClient(), []);
  // The season of the league being looked at, never just "the" league.
  const leagueId = useClub().league?.id ?? null;
  const [state, setState] = useState<SeasonState>({ status: "loading" });

  const load = useCallback(async () => {
    if (!leagueId) {
      setState({ status: "error", message: "This club has no league yet." });
      return;
    }

    const fetchSeason = () =>
      supabase.rpc("league_season", { in_league_id: leagueId, in_year: year ?? null });

    // Whether a live week counts: a league_rules column, not in league_season().
    const fetchCount = () =>
      supabase.from("league_rules").select("standings_count").eq("league_id", leagueId).maybeSingle();

    let [{ data, error }, chosen] = await Promise.all([fetchSeason(), fetchCount()]);

    // Straight after a token refresh the database can judge the new token as
    // issued a moment in the future ("JWT issued at future") and refuse it.
    // The page's other reads start later and never see it; one retry a
    // second on clears it here too.
    if (error) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      [{ data, error }, chosen] = await Promise.all([fetchSeason(), fetchCount()]);
    }

    if (error) {
      setState({ status: "error", message: error.message });
      return;
    }

    const raw = data as unknown as RawSeason;
    const rules: LeagueRules = {
      ...DEFAULT_RULES,
      ...(raw.rules ?? {}),
      standingsCount: chosen.data?.standings_count === "live" ? "live" : "final",
    };

    // Each final week's handicaps as they were when it was marked final, so a
    // new index never re-ranks a settled week. Missing before 0054: then every
    // week is ranked on today's index, as it was.
    const finalIds = raw.rounds.filter((r) => r.status === "final").map((r) => r.id);
    if (finalIds.length > 0) {
      const { data: frozen } = await supabase
        .from("round_handicaps")
        .select("round_id, player_id, handicap_index")
        .in("round_id", finalIds);
      const byRound = new Map<string, Record<string, number | null>>();
      for (const row of (frozen ?? []) as { round_id: string; player_id: string; handicap_index: number | null }[]) {
        const week = byRound.get(row.round_id) ?? {};
        week[row.player_id] = row.handicap_index === null ? null : Number(row.handicap_index);
        byRound.set(row.round_id, week);
      }
      raw.rounds = raw.rounds.map((r) =>
        byRound.has(r.id) ? { ...r, frozenIndexes: byRound.get(r.id) } : r,
      );
    }

    // A week nobody has scored in yet has nothing to rank. One being played
    // counts only if the league shows the current leader during the week.
    const scored = raw.rounds.filter((round) => round.scores.length > 0);
    const played = scored.filter((round) => weekCounts(round.status, rules.standingsCount));
    const waiting = scored
      .filter((round) => !weekCounts(round.status, rules.standingsCount))
      .map((round) => ({ id: round.id, name: round.name, status: round.status }));

    // Scored both ways from the same cards. It is the same arithmetic the
    // live leaderboard does, and cheap enough to do twice, so looking at
    // gross costs nothing and asks the database nothing.
    const score = (ranking: "net" | "gross"): Ranked => {
      const applied: LeagueRules = { ...rules, ranking };
      const weeks = played.map((round) =>
        scoreWeek(round, raw.players, { leagueSkins: raw.leagueSkins, rules: applied }),
      );

      return { weeks, standings: seasonStandings(weeks, raw.players, applied) };
    };

    const net = score("net");
    const gross = score("gross");
    const official = rules.ranking === "gross" ? gross : net;

    setState({
      status: "ready",
      season: {
        year: raw.year,
        leagueSkins: raw.leagueSkins,
        rules,
        years: raw.years?.length ? raw.years : [raw.year],
        closed: raw.closed ?? null,
        players: raw.players,
        rounds: raw.rounds,
        waiting,
        provisional: official.weeks.some((w) => w.counts && w.provisional),
        weeks: official.weeks,
        standings: official.standings,
        net,
        gross,
      },
    });
  }, [supabase, leagueId, year]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return { state, reload: load };
}
