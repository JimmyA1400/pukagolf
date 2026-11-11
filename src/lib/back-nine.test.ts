import { describe, expect, it } from "vitest";

import { holesLabel, roundHoles } from "./holes";
import { netField } from "./net";
import { buildScorecard, nextEnterableHole } from "./scorecard";
import { playSkins } from "./skins";
import { scoreWeek, type SeasonPlayer, type SeasonRound } from "./standings";

/** An 18-hole course, every hole a par 4. */
const pars = Object.fromEntries(roundHoles(18).map((h) => [h, 4]));

/** Stroke indexes as most cards have them: odd on the front, even on the back. */
const strokeIndexes = Object.fromEntries(
  roundHoles(18).map((h) => [h, h <= 9 ? h * 2 - 1 : (h - 9) * 2]),
);

const BACK = roundHoles(9, 10);

/** The same score on every hole of the back nine. */
const card = (playerId: string, strokes: number) =>
  BACK.map((hole) => ({ playerId, hole, strokes }));

describe("roundHoles", () => {
  it("lists a full round, the front nine and the back nine", () => {
    expect(roundHoles(18)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(roundHoles(9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(roundHoles(9, 10)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("names the back nine", () => {
    expect(holesLabel(18)).toBe("18 holes");
    expect(holesLabel(9)).toBe("9 holes");
    expect(holesLabel(9, 10)).toBe("Back nine");
  });
});

describe("a back-nine week", () => {
  it("is a card of holes 10 to 18, one segment labelled IN", () => {
    const scorecard = buildScorecard(pars, [], 9, {}, 10);

    expect(scorecard.segments.map((s) => s.label)).toEqual(["IN"]);
    expect(scorecard.segments[0].cells.map((c) => c.hole)).toEqual(BACK);
    expect(nextEnterableHole(scorecard)).toBe(10);
  });

  it("is complete once holes 10 to 18 are in, and ignores anything on the front", () => {
    const scorecard = buildScorecard(
      pars,
      [...card("a", 4), { playerId: "a", hole: 1, strokes: 9 }],
      9,
      {},
      10,
    );

    expect(scorecard.complete).toBe(true);
    expect(scorecard.toPar).toBe(0);
  });

  it("still splits an 18-hole round at the turn", () => {
    expect(buildScorecard(pars, [], 18).segments.map((s) => s.label)).toEqual(["OUT", "IN"]);
  });

  it("plays skins from hole 10", () => {
    const game = playSkins([...card("a", 3), ...card("b", 4)], ["a", "b"], {
      stake: 5,
      pars,
      holeCount: 9,
      startHole: 10,
    });

    expect(game.holes[0].hole).toBe(10);
    expect(game.winnings.a).toBe(45);
  });

  it("gives net strokes on the back nine's hardest holes", () => {
    // An unrated index of 4 is 2 strokes over nine: holes 10 (SI 2) and 11 (SI 4).
    const field = netField({
      players: [{ id: "a", handicapIndex: 4, preferredTee: null }],
      tees: [],
      coursePar: 72,
      holeCount: 9,
      strokeIndexes,
      startHole: 10,
    });

    expect(field.handicaps.a).toBe(2);
    expect(field.received.a[10]).toBe(1);
    expect(field.received.a[11]).toBe(1);
    expect(field.received.a[12] ?? 0).toBe(0);
    expect(Object.keys(field.received.a).map(Number).every((h) => h >= 10)).toBe(true);
  });

  it("is ranked, finished and paid in the standings", () => {
    const players: SeasonPlayer[] = [
      { id: "a", name: "Amy", handicapIndex: null, preferredTee: null },
      { id: "b", name: "Bob", handicapIndex: null, preferredTee: null },
    ];
    const round: SeasonRound = {
      id: "r",
      name: "Back nine week",
      playedOn: "2026-06-01",
      status: "final",
      holeCount: 9,
      startHole: 10,
      skinsEnabled: true,
      skinsStake: 5,
      pars,
      strokeIndexes,
      tees: [],
      groups: [{ id: "g", playerIds: ["a", "b"], playedTees: {} }],
      scores: [...card("a", 4), ...card("b", 5)],
    };

    const week = scoreWeek(round, players, { leagueSkins: true });
    const amy = week.results.find((r) => r.playerId === "a")!;

    expect(amy.complete).toBe(true);
    expect(amy.position).toBe(1);
    expect(amy.skinsWon).toBe(45);
  });
});
