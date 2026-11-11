import { describe, expect, it } from "vitest";

import {
  DEFAULT_RULES,
  pointsFor,
  scoreWeek,
  seasonStandings,
  weekCounts,
  type LeagueRules,
  type SeasonPlayer,
  type SeasonRound,
} from "./standings";

/** Nine holes, par 4 each, stroke index = hole number. */
const pars = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), 4]));
const strokeIndexes = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [String(i + 1), i + 1]),
);

const players: SeasonPlayer[] = [
  { id: "a", name: "Amy", handicapIndex: 0, preferredTee: null },
  { id: "b", name: "Bob", handicapIndex: 18, preferredTee: null },
  { id: "c", name: "Cal", handicapIndex: null, preferredTee: null },
];

/** A card of the same score on every hole. */
const card = (playerId: string, strokes: number, holes = 9) =>
  Array.from({ length: holes }, (_, i) => ({ playerId, hole: i + 1, strokes }));

const round = (over: Partial<SeasonRound> = {}): SeasonRound => ({
  id: "r1",
  name: "Week 1",
  playedOn: "2026-06-06",
  status: "final",
  holeCount: 9,
  skinsEnabled: true,
  skinsStake: 5,
  pars,
  strokeIndexes,
  tees: [{ tee: "white", courseRating: null, slope: null, yardage: 3000 }],
  groups: [{ id: "g1", playerIds: ["a", "b", "c"], playedTees: {} }],
  scores: [],
  ...over,
});

describe("pointsFor", () => {
  it("follows the table, then a point for completing", () => {
    expect(pointsFor(1)).toBe(10);
    expect(pointsFor(7)).toBe(2);
    expect(pointsFor(12)).toBe(1);
  });
});

describe("scoreWeek", () => {
  it("ranks by net, so the higher handicap can win on fewer strokes' worth", () => {
    // Amy (scratch) shoots 36 gross. Bob (18 → 9 for nine holes) shoots 42
    // gross, 33 net.
    const week = scoreWeek(
      round({ scores: [...card("a", 4), ...card("b", 5, 9).map((s, i) => ({ ...s, strokes: i < 6 ? 5 : 4 }))] }),
      players,
      { leagueSkins: false },
    );

    expect(week.rankedBy).toBe("net");
    const bob = week.results.find((r) => r.playerId === "b")!;
    const amy = week.results.find((r) => r.playerId === "a")!;
    expect(bob.position).toBe(1);
    expect(amy.position).toBe(2);
    expect(bob.points).toBe(10);
  });

  it("gives no points for a card that wasn't finished", () => {
    const week = scoreWeek(
      round({ scores: [...card("a", 4), ...card("b", 3, 5)] }),
      players,
      { leagueSkins: false },
    );

    const bob = week.results.find((r) => r.playerId === "b")!;
    expect(bob.complete).toBe(false);
    expect(bob.points).toBe(0);
  });

  it("falls back to gross when the course has no stroke indexes", () => {
    const week = scoreWeek(
      round({ strokeIndexes: {}, scores: [...card("a", 4), ...card("b", 5)] }),
      players,
      { leagueSkins: false },
    );

    expect(week.rankedBy).toBe("gross");
    expect(week.grossBecause).toBe("no_stroke_indexes");
    expect(week.results.find((r) => r.playerId === "a")!.position).toBe(1);
  });

  it("falls back to gross, and says why, when nobody in the week has a handicap index", () => {
    const noIndex: SeasonPlayer[] = [
      { id: "c", name: "Cal", handicapIndex: null, preferredTee: null },
      { id: "d", name: "Dee", handicapIndex: null, preferredTee: null },
    ];
    const week = scoreWeek(
      round({ groups: [{ id: "g1", playerIds: ["c", "d"], playedTees: {} }], scores: [...card("c", 4), ...card("d", 5)] }),
      noIndex,
      { leagueSkins: false },
    );

    expect(week.rankedBy).toBe("gross");
    expect(week.grossBecause).toBe("no_index");
  });

  it("gives no reason for a week ranked net", () => {
    const week = scoreWeek(round({ scores: [...card("a", 4), ...card("b", 5)] }), players, { leagueSkins: false });
    expect(week.rankedBy).toBe("net");
    expect(week.grossBecause).toBeUndefined();
  });

  it("pays skins within the group when skins are on", () => {
    // Amy wins every hole outright at 3 against Bob's and Cal's 4s.
    const week = scoreWeek(
      round({ scores: [...card("a", 3), ...card("b", 4), ...card("c", 4)] }),
      players,
      { leagueSkins: true },
    );

    expect(week.results.find((r) => r.playerId === "a")!.skinsWon).toBe(45);
  });

  it("pays no skins when the league has them switched off", () => {
    const week = scoreWeek(
      round({ scores: [...card("a", 3), ...card("b", 4), ...card("c", 4)] }),
      players,
      { leagueSkins: false },
    );

    expect(week.results.every((r) => r.skinsWon === 0)).toBe(true);
  });

  it("pays no skins in a week that had them off", () => {
    const week = scoreWeek(
      round({ skinsEnabled: false, scores: [...card("a", 3), ...card("b", 4), ...card("c", 4)] }),
      players,
      { leagueSkins: true },
    );

    expect(week.results.every((r) => r.skinsWon === 0)).toBe(true);
  });

  it("ranks a Stableford week on points, not strokes", () => {
    // Amy goes round in 4s. Cal matches her for eight holes and takes a 10 on
    // the ninth: six strokes worse, one point worse.
    const week = scoreWeek(
      round({
        game: "stableford",
        scores: [
          ...card("a", 4),
          ...card("c", 4).map((s) => (s.hole === 9 ? { ...s, strokes: 10 } : s)),
        ],
      }),
      players,
      { leagueSkins: false, rules: { ...DEFAULT_RULES, ranking: "gross" } },
    );

    const amy = week.results.find((r) => r.playerId === "a")!;
    const cal = week.results.find((r) => r.playerId === "c")!;

    expect(week.game).toBe("stableford");
    expect(amy).toMatchObject({ position: 1, gamePoints: 18 });
    expect(cal).toMatchObject({ position: 2, gamePoints: 16 });
  });

  it("gives everyone in a scramble side the side's place, and pays no skins", () => {
    const week = scoreWeek(
      round({
        game: "scramble",
        groups: [
          { id: "g1", playerIds: ["a", "b"], playedTees: {} },
          { id: "g2", playerIds: ["c"], playedTees: {} },
        ],
        // One ball each side: the same number on every card in the group.
        scores: [...card("a", 4), ...card("b", 4), ...card("c", 5)],
      }),
      players,
      { leagueSkins: true },
    );

    // No allowance exists for a side sharing a ball, so the week is gross.
    expect(week.rankedBy).toBe("gross");
    expect(week.results.find((r) => r.playerId === "a")).toMatchObject({
      position: 1,
      points: 10,
    });
    expect(week.results.find((r) => r.playerId === "b")).toMatchObject({
      position: 1,
      points: 10,
    });
    expect(week.results.find((r) => r.playerId === "c")).toMatchObject({ position: 2 });
    expect(week.results.every((r) => r.skinsWon === 0)).toBe(true);
  });

  it("scores a best-ball side off its lowest card on each hole", () => {
    const week = scoreWeek(
      round({
        game: "best_ball",
        groups: [
          { id: "g1", playerIds: ["a", "c"], playedTees: {} },
          { id: "g2", playerIds: ["b"], playedTees: {} },
        ],
        scores: [...card("a", 5), ...card("c", 4), ...card("b", 4)],
      }),
      players,
      { leagueSkins: false, rules: { ...DEFAULT_RULES, ranking: "gross" } },
    );

    // The side is level on Cal's 4s, and ties Bob playing on his own.
    expect(week.results.find((r) => r.playerId === "a")).toMatchObject({
      position: 1,
      grossToPar: 0,
    });
    expect(week.results.find((r) => r.playerId === "b")?.position).toBe(1);
  });

  it("counts a player who played, even when their side never finished a hole", () => {
    const week = scoreWeek(
      round({
        game: "best_ball",
        groups: [{ id: "g1", playerIds: ["a", "b"], playedTees: {} }],
        // Amy played the whole nine; Bob never posted, so no hole is complete.
        scores: card("a", 4),
      }),
      players,
      { leagueSkins: false },
    );

    expect(week.results.map((r) => r.playerId)).toEqual(["a"]);
    expect(week.results[0]).toMatchObject({ complete: false, position: null, points: 0 });
  });
});

describe("seasonStandings", () => {
  it("adds up points across weeks and counts wins", () => {
    const w1 = scoreWeek(round({ scores: [...card("a", 4), ...card("b", 6)] }), players, { leagueSkins: false });
    const w2 = scoreWeek(
      round({ id: "r2", name: "Week 2", scores: [...card("a", 4), ...card("b", 6)] }),
      players,
      { leagueSkins: false },
    );

    const table = seasonStandings([w1, w2], players);

    expect(table[0].name).toBe("Amy");
    expect(table[0].points).toBe(20);
    expect(table[0].wins).toBe(2);
    expect(table[0].weeksPlayed).toBe(2);
  });

  it("gives tied players the same position", () => {
    const w = scoreWeek(round({ scores: [...card("a", 4), ...card("b", 5)] }), players, { leagueSkins: false });
    // Bob's 9 net strokes back make his 45 a 36: level with Amy.
    const table = seasonStandings([w], players).filter((r) => r.weeksPlayed > 0);

    expect(table.map((r) => r.position)).toEqual([1, 1]);
    expect(table.every((r) => r.points === 10)).toBe(true);
  });

  it("lists someone in a group who hasn't posted a score yet, at nothing", () => {
    const w = scoreWeek(round({ scores: [...card("a", 4), ...card("b", 5)] }), players, { leagueSkins: false });
    const carl = seasonStandings([w], players).find((r) => r.playerId === "c");

    expect(carl).toMatchObject({ points: 0, weeksPlayed: 0, completed: 0 });
  });
});

describe("league rules", () => {
  const rules = (over: Partial<LeagueRules> = {}): LeagueRules => ({ ...DEFAULT_RULES, ...over });
  const gross = (over: Partial<SeasonRound> = {}) => round({ strokeIndexes: {}, ...over });

  it("uses the league's own points table and finishing point", () => {
    const week = scoreWeek(
      gross({ scores: [...card("a", 4), ...card("b", 5), ...card("c", 6)] }),
      players,
      { leagueSkins: false, rules: rules({ points: [5, 3], completionPoint: 2 }) },
    );

    expect(week.results.map((r) => [r.playerId, r.points])).toEqual([
      ["a", 5],
      ["b", 3],
      ["c", 2],
    ]);
  });

  it("ranks gross when the league says so, even on a rated course", () => {
    // Net, Bob's 45 less 9 strokes ties Amy's 36; gross, Amy wins outright.
    const week = scoreWeek(
      round({ scores: [...card("a", 4), ...card("b", 5)] }),
      players,
      { leagueSkins: false, rules: rules({ ranking: "gross" }) },
    );

    expect(week.rankedBy).toBe("gross");
    expect(week.results.find((r) => r.playerId === "a")!.position).toBe(1);
    expect(week.results.find((r) => r.playerId === "b")!.position).toBe(2);
  });

  it("keeps guests out of the places unless guests score", () => {
    const withGuest: SeasonPlayer[] = [
      ...players,
      { id: "g", name: "Gus", handicapIndex: null, preferredTee: null, isGuest: true },
    ];
    const played = gross({
      groups: [{ id: "g1", playerIds: ["a", "g"], playedTees: {} }],
      scores: [...card("g", 3), ...card("a", 4)],
    });

    const unranked = scoreWeek(played, withGuest, { leagueSkins: false });
    expect(unranked.results.find((r) => r.playerId === "a")!.position).toBe(1);
    expect(unranked.results.find((r) => r.playerId === "g")!.points).toBe(0);
    expect(seasonStandings([unranked], withGuest).map((r) => r.playerId)).toEqual(["a"]);

    const ranked = scoreWeek(played, withGuest, {
      leagueSkins: false,
      rules: rules({ guestsScore: true }),
    });
    expect(ranked.results.find((r) => r.playerId === "g")!.position).toBe(1);
  });

  it("drops each player's worst weeks, a missed week counting as a zero", () => {
    const weeks = [
      scoreWeek(gross({ id: "r1", scores: [...card("a", 4), ...card("b", 5)] }), players, { leagueSkins: false }),
      scoreWeek(gross({ id: "r2", scores: [...card("a", 5), ...card("b", 4)] }), players, { leagueSkins: false }),
      scoreWeek(gross({ id: "r3", scores: [...card("a", 4)] }), players, { leagueSkins: false }),
    ];

    // Amy: 10, 8, 10 → best two, 20. Bob: 8, 10 and a missed week → 18.
    const table = seasonStandings(weeks, players, rules({ dropWorst: 1 }));

    expect(table.find((r) => r.playerId === "a")!.points).toBe(20);
    expect(table.find((r) => r.playerId === "b")!.points).toBe(18);
  });

  it("lists players short of the qualifying weeks below everyone, unranked", () => {
    const weeks = [
      scoreWeek(gross({ id: "r1", scores: [...card("a", 5), ...card("b", 4)] }), players, { leagueSkins: false }),
      scoreWeek(gross({ id: "r2", scores: [...card("a", 5)] }), players, { leagueSkins: false }),
    ];

    const table = seasonStandings(weeks, players, rules({ minWeeks: 2 }));

    expect(table.map((r) => [r.playerId, r.position, r.qualified])).toEqual([
      ["a", 1, true],
      ["b", 0, false],
      // In the group both weeks, never posted.
      ["c", 0, false],
    ]);
  });

  it("leaves a rained-out week out of the table", () => {
    const played = scoreWeek(gross({ id: "r1", scores: [...card("a", 4), ...card("b", 5)] }), players, {
      leagueSkins: false,
    });
    const rained = scoreWeek(
      gross({ id: "r2", countsForStandings: false, scores: [...card("b", 4), ...card("a", 5)] }),
      players,
      { leagueSkins: false },
    );

    const table = seasonStandings([played, rained], players);

    expect(rained.counts).toBe(false);
    expect(table.find((r) => r.playerId === "a")!.points).toBe(10);
    expect(table.find((r) => r.playerId === "b")!.weeksPlayed).toBe(1);
  });
});

describe("which weeks count", () => {
  it("counts only final weeks unless the league shows the leader during the week", () => {
    expect(weekCounts("final")).toBe(true);
    expect(weekCounts("live")).toBe(false);
    expect(weekCounts("live", "live")).toBe(true);
  });

  it("never counts a week still being set up", () => {
    expect(weekCounts("setup")).toBe(false);
    expect(weekCounts("setup", "live")).toBe(false);
  });

  it("marks a week that isn't final as provisional", () => {
    const live = scoreWeek(round({ status: "live", scores: card("a", 4) }), players, { leagueSkins: false });
    const done = scoreWeek(round({ status: "final", scores: card("a", 4) }), players, { leagueSkins: false });

    expect(live.provisional).toBe(true);
    expect(done.provisional).toBe(false);
  });
});
