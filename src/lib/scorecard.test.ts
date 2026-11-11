import { describe, expect, it } from "vitest";

import type { Score } from "./leaderboard";
import {
  buildScorecard,
  holeResult,
  nextEnterableHole,
  type CoursePars,
} from "./scorecard";

/** A real par-72 layout, so OUT and IN differ and totals are checkable. */
const PARS: CoursePars = {
  1: 4, 2: 4, 3: 3, 4: 5, 5: 4, 6: 3, 7: 4, 8: 5, 9: 4, // OUT 36
  10: 4, 11: 4, 12: 3, 13: 5, 14: 4, 15: 3, 16: 4, 17: 5, 18: 4, // IN 36
};

const card = (strokesByHole: Record<number, number>): Score[] =>
  Object.entries(strokesByHole).map(([hole, strokes]) => ({
    playerId: "P1",
    hole: Number(hole),
    strokes,
  }));

/** Every hole played to par. */
const evenPar = () =>
  card(Object.fromEntries(Object.entries(PARS).map(([h, p]) => [h, p])));

describe("buildScorecard", () => {
  it("splits eighteen holes at the turn", () => {
    const sc = buildScorecard(PARS, []);

    expect(sc.segments.map((s) => s.label)).toEqual(["OUT", "IN"]);
    expect(sc.segments[0].cells).toHaveLength(9);
    expect(sc.segments[1].cells[0].hole).toBe(10);
  });

  it("keeps a nine-hole round as one segment", () => {
    const sc = buildScorecard(PARS, [], 9);

    expect(sc.segments.map((s) => s.label)).toEqual(["TOTAL"]);
    expect(sc.parTotal).toBe(36);
  });

  it("totals par per segment and for the round", () => {
    const sc = buildScorecard(PARS, []);

    expect(sc.segments[0].parTotal).toBe(36);
    expect(sc.segments[1].parTotal).toBe(36);
    expect(sc.parTotal).toBe(72);
  });

  it("leaves unplayed holes null rather than zero", () => {
    const sc = buildScorecard(PARS, card({ 1: 4 }));

    expect(sc.segments[0].cells[0].strokes).toBe(4);
    expect(sc.segments[0].cells[1].strokes).toBeNull();
  });

  it("reports an even-par round as E", () => {
    const sc = buildScorecard(PARS, evenPar());

    expect(sc.strokesTotal).toBe(72);
    expect(sc.toParLabel).toBe("E");
    expect(sc.complete).toBe(true);
  });

  it("measures toPar against holes played, not the whole course", () => {
    // Three holes, one over. Must read +1, not "way under par".
    const sc = buildScorecard(PARS, card({ 1: 4, 2: 4, 3: 4 }));

    expect(sc.thru).toBe(3);
    expect(sc.parToDate).toBe(11);
    expect(sc.toParLabel).toBe("+1");
  });

  it("shows an under-par card with a signed label", () => {
    const sc = buildScorecard(PARS, card({ 1: 3, 2: 3 }));

    expect(sc.toParLabel).toBe("-2");
  });

  it("is not complete until every hole is entered", () => {
    const scores = evenPar().filter((s) => s.hole !== 18);
    const sc = buildScorecard(PARS, scores);

    expect(sc.thru).toBe(17);
    expect(sc.complete).toBe(false);
  });
});

describe("nextEnterableHole", () => {
  it("starts at hole 1 on an empty card", () => {
    expect(nextEnterableHole(buildScorecard(PARS, []))).toBe(1);
  });

  it("advances as holes are entered", () => {
    const sc = buildScorecard(PARS, card({ 1: 4, 2: 5, 3: 3 }));

    expect(nextEnterableHole(sc)).toBe(4);
  });

  it("crosses the turn", () => {
    const scores = evenPar().filter((s) => s.hole <= 9);

    expect(nextEnterableHole(buildScorecard(PARS, scores))).toBe(10);
  });

  it("points at a gap the admin left rather than past it", () => {
    // The admin bypasses the sequential trigger, so this card is reachable.
    // Counting from the number of holes played would wrongly say 4.
    const sc = buildScorecard(PARS, card({ 1: 4, 2: 4, 4: 5 }));

    expect(nextEnterableHole(sc)).toBe(3);
  });

  it("returns null once the card is full", () => {
    expect(nextEnterableHole(buildScorecard(PARS, evenPar()))).toBeNull();
  });
});

describe("holeResult", () => {
  it.each([
    [1, "albatross"],
    [2, "eagle"],
    [3, "birdie"],
    [4, "par"],
    [5, "bogey"],
    [6, "double bogey"],
  ])("names a %i on a par-4 hole", (strokes, expected) => {
    expect(holeResult({ hole: 1, par: 4, strokes })).toBe(expected);
  });

  it("falls back to a signed number beyond double bogey", () => {
    expect(holeResult({ hole: 1, par: 4, strokes: 8 })).toBe("+4");
  });

  it("returns null for a hole not yet played", () => {
    expect(holeResult({ hole: 1, par: 4, strokes: null })).toBeNull();
  });
});

describe("stroke indexes", () => {
  it("carries a stroke index onto each hole", () => {
    const sc = buildScorecard(PARS, [], 18, {
      strokeIndexes: { 1: 7, 2: 13 },
    });

    expect(sc.segments[0].cells[0].strokeIndex).toBe(7);
    expect(sc.segments[0].cells[1].strokeIndex).toBe(13);
  });

  it("leaves holes with no index null rather than zero", () => {
    // Zero would render as a stroke index of 0, which does not exist.
    const sc = buildScorecard(PARS, [], 18, { strokeIndexes: { 1: 7 } });

    expect(sc.segments[0].cells[1].strokeIndex).toBeNull();
  });

  it("is null throughout when the course was never rated", () => {
    const sc = buildScorecard(PARS, []);

    expect(sc.segments[0].cells.every((c) => c.strokeIndex === null)).toBe(true);
  });

  it("carries yardages alongside stroke indexes", () => {
    const sc = buildScorecard(PARS, [], 18, {
      yards: { 1: 350 },
      strokeIndexes: { 1: 7 },
    });

    expect(sc.segments[0].cells[0]).toMatchObject({ yards: 350, strokeIndex: 7 });
  });
});
