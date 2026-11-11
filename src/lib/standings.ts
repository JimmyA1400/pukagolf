/**
 * Season standings: points by weekly finish, plus what each player won in
 * skins.
 *
 * Only a completed round earns points. A player who teed off and didn't
 * finish has no score to compare, and ranking a half card against full ones
 * would reward stopping early.
 *
 * Only a week marked final counts, unless the league has chosen to show the
 * current leader during the week; then a live week counts too, and is marked
 * provisional. A week still being set up never counts.
 */

import { buildGameBoard, getGame, sidesFor, type SideScore } from "./games";
import { roundHoles } from "./holes";
import type { Score } from "./leaderboard";
import { netField, toNetScores, type RatedTee } from "./net";
import { playSkins } from "./skins";

/** Points for finishing 1st, 2nd, 3rd… Anyone further down who completes gets 1. */
export const POINTS = [10, 8, 6, 5, 4, 3, 2] as const;
export const COMPLETION_POINT = 1;

/** How the owner has chosen to score the season (league_settings). */
export type LeagueRules = {
  /** Points for 1st, 2nd, 3rd… */
  points: number[];
  /** For finishing a card anywhere below the table. */
  completionPoint: number;
  /** Each player's worst weeks left out of their points. */
  dropWorst: number;
  /** Weeks played before a player is ranked. */
  minWeeks: number;
  ranking: "net" | "gross";
  /** Whether guests take places and points, or play alongside unranked. */
  guestsScore: boolean;
  /** The game a new week starts under. A week can be set to any other. */
  defaultGame?: string;
  /** The league's Stableford values, which a new week is given a copy of. */
  stableford?: number[];
  /** Whether a live week counts, provisionally, or only final weeks do. */
  standingsCount?: StandingsCount;
};

/** "final": the winner at the end only. "live": the current leader during the week. */
export type StandingsCount = "final" | "live";

/** Whether a week with this status is in the standings yet. */
export function weekCounts(status: string, standingsCount: StandingsCount = "final"): boolean {
  return status === "final" || (status === "live" && standingsCount === "live");
}

export const DEFAULT_RULES: LeagueRules = {
  points: [...POINTS],
  completionPoint: COMPLETION_POINT,
  dropWorst: 0,
  minWeeks: 0,
  ranking: "net",
  guestsScore: false,
};

export type SeasonPlayer = {
  id: string;
  name: string;
  handicapIndex: number | null;
  preferredTee: string | null;
  isGuest?: boolean;
};

export type SeasonRound = {
  id: string;
  name: string;
  playedOn: string;
  status: string;
  holeCount: number;
  /** False for a week marked rained out; missing means it counts. */
  countsForStandings?: boolean;
  /** 10 for a back-nine week; missing means hole 1. */
  startHole?: number;
  /** What the week was played for; missing means stroke play. */
  game?: string;
  /** The week's own Stableford values, where it was played for points. */
  stablefordPoints?: number[] | null;
  skinsEnabled: boolean;
  skinsStake: number;
  /**
   * Each player's handicap index as it was when the week was marked final.
   * A final week is ranked on these, so posting a new index later can't
   * re-rank it; anyone missing falls back to today's index.
   */
  frozenIndexes?: Record<string, number | null>;
  pars: Record<number, number>;
  strokeIndexes: Record<number, number>;
  tees: { tee: string; courseRating: number | null; slope: number | null; yardage: number | null }[];
  groups: { id: string; playerIds: string[]; playedTees: Record<string, string> }[];
  scores: Score[];
};

export type WeekResult = {
  playerId: string;
  complete: boolean;
  /** Finishing position among completed cards; null when not completed. */
  position: number | null;
  points: number;
  netToPar: number | null;
  grossToPar: number | null;
  /** Stableford points, where the week was played for them. */
  gamePoints: number | null;
  skinsWon: number;
  /** A net week this player played with no handicap index, so wasn't ranked. */
  noHandicap: boolean;
};

export type Week = {
  roundId: string;
  name: string;
  playedOn: string;
  /** The game it was played under. See src/lib/games.ts. */
  game: string;
  /** Net, unless the course lacks stroke indexes; then gross, and it says so. */
  rankedBy: "net" | "gross";
  /**
   * Why a week in a net league was ranked gross: the course has no stroke
   * indexes, nobody in it had a handicap index, or the side shared one ball.
   */
  grossBecause?: "no_stroke_indexes" | "no_index" | "one_ball";
  /** False for a rained-out week: shown, but not in the table. */
  counts: boolean;
  /** Still being played: its points aren't official until it's final. */
  provisional: boolean;
  /** Everyone in a group that week, whether or not they've posted a score. */
  field: string[];
  results: WeekResult[];
};

export type StandingRow = {
  playerId: string;
  name: string;
  position: number;
  points: number;
  weeksPlayed: number;
  completed: number;
  wins: number;
  /** Average strokes to par over completed rounds, net where the week was net. */
  average: number | null;
  best: number | null;
  skinsWon: number;
  /** Played enough weeks to be ranked. Position is 0 when not. */
  qualified: boolean;
  /**
   * Every week they played was ranked net and they had no handicap index,
   * so they were never in the table. Not ranked, and not champion material.
   */
  noHandicap: boolean;
};

function keyed(record: Record<string, number>): Record<number, number> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [Number(k), v]));
}

/** Points for a competition-ranked position. */
export function pointsFor(position: number, rules: LeagueRules = DEFAULT_RULES): number {
  return rules.points[position - 1] ?? rules.completionPoint;
}

/** One week's finishing order, points and skins, from its raw data. */
export function scoreWeek(
  round: SeasonRound,
  players: readonly SeasonPlayer[],
  { leagueSkins, rules = DEFAULT_RULES }: { leagueSkins: boolean; rules?: LeagueRules },
): Week {
  const pars = keyed(round.pars);
  const strokeIndexes = keyed(round.strokeIndexes);
  const coursePar = Object.values(pars).reduce((a, b) => a + b, 0);

  const field = round.groups.flatMap((g) => g.playerIds);
  // Anyone who scored counts, even if they were never put in a group.
  for (const s of round.scores) if (!field.includes(s.playerId)) field.push(s.playerId);

  const playedTee = Object.assign({}, ...round.groups.map((g) => g.playedTees));
  const byId = new Map(players.map((p) => [p.id, p]));

  // A course is rated per gender, so one colour can appear twice. Keep the
  // longest, the same choice the live round's tee list makes, so a week is
  // rated identically on the leaderboard and in the standings.
  const longest = new Map<string, RatedTee>();
  for (const t of round.tees) {
    const tee = t.tee.toLowerCase();
    const totalYards = t.yardage ?? 0;
    const existing = longest.get(tee);

    if (!existing || totalYards > existing.totalYards) {
      longest.set(tee, { tee, totalYards, courseRating: t.courseRating, slope: t.slope });
    }
  }
  const tees = [...longest.values()];

  // A final week keeps the index each player had when it was marked final.
  const indexOf = (id: string) =>
    round.status === "final" && round.frozenIndexes && id in round.frozenIndexes
      ? round.frozenIndexes[id]
      : (byId.get(id)?.handicapIndex ?? null);

  const net = netField({
    players: field.map((id) => ({
      id,
      handicapIndex: indexOf(id),
      preferredTee: byId.get(id)?.preferredTee ?? null,
      playedTee: playedTee[id] ?? null,
    })),
    tees,
    coursePar,
    holeCount: round.holeCount,
    strokeIndexes,
    startHole: round.startHole,
  });

  const hasPars = Object.keys(pars).length > 0;
  const spec = getGame(round.game);
  const board = (scores: readonly Score[], ids: readonly string[]) =>
    buildGameBoard({
      game: round.game,
      sides: sidesFor(round.game, ids, round.groups),
      scores,
      pars: hasPars ? pars : undefined,
      holeCount: round.holeCount,
      startHole: round.startHole,
      stableford: round.stablefordPoints ?? undefined,
    });

  const gross = board(round.scores, field);
  const netIds = Object.keys(net.received);
  const netBoard = net.available ? board(toNetScores(round.scores, net.received), netIds) : [];

  // A side sharing one ball has no handicap allowance, so it is gross however
  // the league ranks its other weeks.
  const rankedBy: Week["rankedBy"] =
    rules.ranking === "net" && !spec.grossOnly && net.available && netBoard.length > 0
      ? "net"
      : "gross";
  const ranking = rankedBy === "net" ? netBoard : gross;
  const grossBecause: Week["grossBecause"] =
    rules.ranking !== "net" || rankedBy === "net"
      ? undefined
      : spec.grossOnly
        ? "one_ball"
        : !net.available
          ? "no_stroke_indexes"
          : "no_index";

  // A guest plays alongside, unranked, unless the league lets guests score.
  const takesPlace = (id: string) => rules.guestsScore || !byId.get(id)?.isGuest;

  // Rank completed cards only, in the board's own order. In a team game the
  // side is what finishes and what places; everyone on it shares the result.
  const finished = ranking.filter(
    (row) => row.thru >= round.holeCount && row.playerIds.some(takesPlace),
  );
  const positions = new Map<string, number>();
  finished.forEach((row, i) => {
    const previous = finished[i - 1];
    const tied =
      previous !== undefined &&
      (spec.rankedBy === "points"
        ? row.points === previous.points
        : row.toPar !== null
          ? row.toPar === previous.toPar
          : row.strokes === previous.strokes);
    positions.set(row.id, tied ? positions.get(previous.id)! : i + 1);
  });

  // Skins are played within each group, as the live pot is — except in a
  // scramble, where every card in a group carries the same number and every
  // hole would tie itself into a carry.
  const skinsWon: Record<string, number> = {};
  if (leagueSkins && round.skinsEnabled && round.skinsStake > 0 && !spec.sharedBall) {
    for (const group of round.groups) {
      if (group.playerIds.length < 2) continue;
      const pot = playSkins(round.scores, group.playerIds, {
        stake: round.skinsStake,
        pars,
        holeCount: round.holeCount,
        startHole: round.startHole,
      });
      for (const [id, amount] of Object.entries(pot.winnings)) {
        skinsWon[id] = (skinsWon[id] ?? 0) + amount;
      }
    }
  }

  const sideBy = (rows: readonly SideScore[]) => {
    const byPlayer = new Map<string, SideScore>();
    for (const row of rows) for (const id of row.playerIds) byPlayer.set(id, row);

    return byPlayer;
  };
  const grossBy = sideBy(gross);
  const netBy = sideBy(netBoard);
  const rankedSide = sideBy(ranking);

  // Holes a player put a number on themselves, which is what says they played
  // at all. Their side's progress is a separate question.
  const holes = new Set(roundHoles(round.holeCount, round.startHole));
  const played = new Map<string, number>();
  for (const score of round.scores) {
    if (holes.has(score.hole)) played.set(score.playerId, (played.get(score.playerId) ?? 0) + 1);
  }

  const results: WeekResult[] = field
    .filter((id) => (played.get(id) ?? 0) > 0)
    .map((id) => {
      const side = rankedSide.get(id);
      const position = side && takesPlace(id) ? (positions.get(side.id) ?? null) : null;

      return {
        playerId: id,
        complete: (grossBy.get(id)?.thru ?? 0) >= round.holeCount,
        position,
        points: position === null ? 0 : pointsFor(position, rules),
        netToPar: netBy.get(id)?.toPar ?? null,
        grossToPar: grossBy.get(id)?.toPar ?? null,
        gamePoints: side?.points ?? null,
        skinsWon: skinsWon[id] ?? 0,
        noHandicap: rankedBy === "net" && !side,
      };
    });

  return {
    roundId: round.id,
    name: round.name,
    playedOn: round.playedOn,
    game: spec.id,
    rankedBy,
    ...(grossBecause ? { grossBecause } : {}),
    counts: round.countsForStandings ?? true,
    provisional: round.status !== "final",
    field,
    results,
  };
}

/**
 * The season table from its weeks, under the league's rules.
 *
 * A rained-out week is left out of points, wins and averages; its skins were
 * still paid, so they still count. With weeks dropped, each player's best
 * (weeks − dropped) weeks count, a week they missed being a zero. Anyone
 * short of the qualifying weeks is listed below the ranked players, unranked.
 */
export function seasonStandings(
  weeks: readonly Week[],
  players: readonly SeasonPlayer[],
  rules: LeagueRules = DEFAULT_RULES,
): StandingRow[] {
  const nameOf = new Map(players.map((p) => [p.id, p.name]));
  const guests = new Set(players.filter((p) => p.isGuest).map((p) => p.id));
  const counting = weeks.filter((w) => w.counts).length;
  const rows = new Map<string, StandingRow & { toPars: number[]; weekly: number[]; rankedWeeks: number }>();

  const rowFor = (playerId: string) => {
    const existing = rows.get(playerId);
    if (existing) return existing;

    const row = {
      playerId,
      name: nameOf.get(playerId) ?? "Former player",
      position: 0,
      points: 0,
      weeksPlayed: 0,
      completed: 0,
      wins: 0,
      average: null,
      best: null,
      skinsWon: 0,
      qualified: false,
      noHandicap: false,
      toPars: [] as number[],
      weekly: [] as number[],
      rankedWeeks: 0,
    };
    rows.set(playerId, row);
    return row;
  };

  for (const week of weeks) {
    // Everyone in a group is on the table, at nothing if they haven't
    // posted yet, so nobody in the week goes missing from it.
    if (week.counts) {
      for (const id of week.field) {
        if (!guests.has(id) || rules.guestsScore) rowFor(id);
      }
    }

    for (const r of week.results) {
      if (guests.has(r.playerId) && !rules.guestsScore) continue;

      const row = rowFor(r.playerId);
      row.skinsWon += r.skinsWon;

      if (!week.counts) continue;

      row.weekly.push(r.points);
      row.weeksPlayed += 1;
      if (!r.noHandicap) row.rankedWeeks += 1;

      if (r.complete) {
        row.completed += 1;
        if (r.position === 1) row.wins += 1;

        const toPar = week.rankedBy === "net" ? r.netToPar : r.grossToPar;
        if (toPar !== null) row.toPars.push(toPar);
      }
    }
  }

  const keep = Math.max(counting - rules.dropWorst, 1);

  const list = [...rows.values()].map(({ toPars, weekly, rankedWeeks, ...row }) => {
    const missed = Array<number>(Math.max(counting - weekly.length, 0)).fill(0);
    const kept = [...weekly, ...missed].sort((a, b) => b - a).slice(0, keep);
    // Played, but never with a handicap in a net week: never in the table.
    const noHandicap = row.weeksPlayed > 0 && rankedWeeks === 0;

    return {
      ...row,
      points: kept.reduce((a, b) => a + b, 0),
      noHandicap,
      qualified: !noHandicap && row.weeksPlayed >= rules.minWeeks,
      average: toPars.length
        ? Math.round((toPars.reduce((a, b) => a + b, 0) / toPars.length) * 10) / 10
        : null,
      best: toPars.length ? Math.min(...toPars) : null,
    };
  });

  // Ranked players first; then points, wins, and the better average. A player
  // with no average (never completed a round) goes below one with.
  list.sort(
    (a, b) =>
      Number(b.qualified) - Number(a.qualified) ||
      b.points - a.points ||
      b.wins - a.wins ||
      (a.average ?? Infinity) - (b.average ?? Infinity) ||
      a.name.localeCompare(b.name),
  );

  list.forEach((row, i) => {
    if (!row.qualified) {
      row.position = 0;
      return;
    }

    const previous = list[i - 1];
    const tied =
      previous !== undefined &&
      previous.points === row.points &&
      previous.wins === row.wins &&
      previous.average === row.average;
    row.position = tied ? previous.position : i + 1;
  });

  return list;
}
