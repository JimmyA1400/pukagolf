import { describe, expect, it } from "vitest";

import {
  adjustedGross,
  courseHandicap,
  differential,
  handicapIndex,
  indexFromDifferentials,
  nineHoleDifferential,
  nineHoleRating,
  strokesPerHole,
  type ScoringRecord,
} from "./handicap";

/** A round on a course of average difficulty, so slope cancels out. */
const record = (
  adjusted: number,
  playedOn: string,
  slope = 113,
  courseRating = 72,
): ScoringRecord => ({
  adjustedGross: adjusted,
  courseRating,
  slope,
  playedOn,
});

/** n rounds all shooting the same score, dated backwards from 2026-06-01. */
const rounds = (n: number, gross: number): ScoringRecord[] =>
  Array.from({ length: n }, (_, i) =>
    record(gross, `2026-05-${String(i + 1).padStart(2, "0")}`),
  );

describe("differential", () => {
  it("is the gap to the rating on a course of average slope", () => {
    // 113/113 = 1, so the differential is simply gross minus rating.
    expect(differential(85, 72, 113)).toBe(13);
  });

  it("scales down on a harder course", () => {
    // The same score is worth less on a steeper slope.
    expect(differential(85, 72, 140)).toBe(10.5);
  });

  it("scales up on an easier course", () => {
    expect(differential(85, 72, 90)).toBe(16.3);
  });

  it("goes negative for a round better than the rating", () => {
    expect(differential(68, 72, 113)).toBe(-4);
  });

  it("rounds to one decimal", () => {
    expect(differential(85, 71.6, 122)).toBe(12.4);
  });

  it("refuses a slope of zero rather than dividing by it", () => {
    expect(() => differential(85, 72, 0)).toThrow(/slope/i);
  });
});

describe("handicapIndex", () => {
  it("stays provisional under three rounds", () => {
    const result = handicapIndex(rounds(2, 90), 15.2);

    expect(result).toMatchObject({
      status: "provisional",
      index: 15.2,
      roundsPosted: 2,
      roundsNeeded: 1,
    });
  });

  it("reports provisional with no self-reported figure either", () => {
    const result = handicapIndex([], null);

    expect(result).toMatchObject({ status: "provisional", index: null });
  });

  it("takes the best one minus 2.0 at exactly three rounds", () => {
    // The published table: one good round is weak evidence, so it is penalised.
    const result = handicapIndex(
      [record(85, "2026-05-01"), record(90, "2026-05-02"), record(95, "2026-05-03")],
      null,
    );

    // Best differential is 13; 13 - 2.0 = 11.0
    expect(result).toMatchObject({ status: "calculated", index: 11 });
  });

  it("takes the best one minus 1.0 at four rounds", () => {
    const result = handicapIndex(
      [
        record(85, "2026-05-01"),
        record(90, "2026-05-02"),
        record(95, "2026-05-03"),
        record(96, "2026-05-04"),
      ],
      null,
    );

    expect((result as { index: number }).index).toBe(12);
  });

  it("takes the best one with no adjustment at five rounds", () => {
    const result = handicapIndex(
      [
        record(85, "2026-05-01"),
        ...rounds(4, 100).map((r, i) => record(100, `2026-05-1${i}`)),
      ],
      null,
    );

    expect((result as { index: number }).index).toBe(13);
  });

  it("averages the lowest two minus 1.0 at six rounds", () => {
    const scores = [85, 87, 95, 96, 97, 98];
    const result = handicapIndex(
      scores.map((g, i) => record(g, `2026-05-0${i + 1}`)),
      null,
    );

    // Differentials 13 and 15, mean 14, minus 1.0
    expect((result as { index: number }).index).toBe(13);
  });

  it("averages the lowest eight at twenty rounds", () => {
    // Eight rounds of 80 and twelve of 100: the eight lowest are the 80s.
    const scores = [
      ...Array(8).fill(80),
      ...Array(12).fill(100),
    ];
    const result = handicapIndex(
      scores.map((g, i) => record(g, `2026-05-${String(i + 1).padStart(2, "0")}`)),
      null,
    );

    expect(result).toMatchObject({ status: "calculated", index: 8, differentialsUsed: 8 });
  });

  it("considers only the most recent twenty", () => {
    // Thirty rounds: ten brilliant OLD ones, twenty ordinary recent ones. The
    // old ones must not count, or a player never gets worse.
    const old = Array.from({ length: 10 }, (_, i) =>
      record(70, `2026-01-${String(i + 1).padStart(2, "0")}`),
    );
    const recent = Array.from({ length: 20 }, (_, i) =>
      record(95, `2026-05-${String(i + 1).padStart(2, "0")}`),
    );

    const result = handicapIndex([...old, ...recent], null);

    expect((result as { index: number }).index).toBe(23);
    expect((result as { roundsPosted: number }).roundsPosted).toBe(30);
  });

  it("is unaffected by the order records arrive in", () => {
    const scores = [85, 90, 95, 100, 105, 110];
    const forwards = scores.map((g, i) => record(g, `2026-05-0${i + 1}`));
    const backwards = [...forwards].reverse();

    expect(handicapIndex(forwards, null)).toEqual(handicapIndex(backwards, null));
  });

  it("produces a plus index for a player better than the ratings", () => {
    const result = handicapIndex(rounds(20, 69), null);

    expect((result as { index: number }).index).toBe(-3);
  });

  it("rounds to one decimal", () => {
    const scores = [85, 86, 88];
    const result = handicapIndex(
      scores.map((g, i) => record(g, `2026-05-0${i + 1}`)),
      null,
    );

    expect(Number.isInteger((result as { index: number }).index * 10)).toBe(true);
  });
});

describe("courseHandicap", () => {
  it("is the index on a course of average slope rated to par", () => {
    expect(courseHandicap(12, 113, 72, 72)).toBe(12);
  });

  it("gives more strokes on a steeper slope", () => {
    expect(courseHandicap(12, 140, 72, 72)).toBe(15);
  });

  it("gives more strokes when the rating exceeds par", () => {
    // A course rated 74.5 off a par of 72 plays two and a half shots harder.
    expect(courseHandicap(12, 113, 74.5, 72)).toBe(15);
  });

  it("handles a plus handicap", () => {
    expect(courseHandicap(-2, 113, 72, 72)).toBe(-2);
  });
});

describe("strokesPerHole", () => {
  // Stroke index 1 is the hardest hole, 18 the easiest.
  const indexes = Object.fromEntries(
    Array.from({ length: 18 }, (_, i) => [i + 1, i + 1]),
  );

  it("gives no strokes at scratch", () => {
    const strokes = strokesPerHole(0, indexes);

    expect(Object.values(strokes).every((s) => s === 0)).toBe(true);
  });

  it("gives strokes on the hardest holes first", () => {
    const strokes = strokesPerHole(3, indexes);

    expect(strokes[1]).toBe(1);
    expect(strokes[2]).toBe(1);
    expect(strokes[3]).toBe(1);
    expect(strokes[4]).toBe(0);
  });

  it("gives one stroke on every hole at eighteen", () => {
    const strokes = strokesPerHole(18, indexes);

    expect(Object.values(strokes).every((s) => s === 1)).toBe(true);
  });

  it("wraps to a second stroke on the hardest holes beyond eighteen", () => {
    const strokes = strokesPerHole(20, indexes);

    expect(strokes[1]).toBe(2);
    expect(strokes[2]).toBe(2);
    expect(strokes[3]).toBe(1);
  });

  it("takes strokes back from the easiest holes for a plus handicap", () => {
    // A +2 player gives two shots, and gives them where they hurt least.
    const strokes = strokesPerHole(-2, indexes);

    expect(strokes[18]).toBe(-1);
    expect(strokes[17]).toBe(-1);
    expect(strokes[1]).toBe(0);
  });

  it("totals to the course handicap", () => {
    const total = Object.values(strokesPerHole(11, indexes)).reduce(
      (a, b) => a + b,
      0,
    );

    expect(total).toBe(11);
  });

  it("survives a course with no stroke indexes", () => {
    expect(strokesPerHole(12, {})).toEqual({});
  });
});

describe("adjustedGross", () => {
  const pars = { 1: 4, 2: 4, 3: 5 };

  it("leaves a clean round alone", () => {
    expect(adjustedGross({ 1: 4, 2: 5, 3: 5 }, pars)).toBe(14);
  });

  it("caps a blow-up hole at net double bogey", () => {
    // A 9 on a par 4 with no stroke counts as 6.
    expect(adjustedGross({ 1: 9 }, pars)).toBe(6);
  });

  it("raises the cap by the strokes received on that hole", () => {
    // Same 9, but the player gets a stroke: cap is 7.
    expect(adjustedGross({ 1: 9 }, pars, { 1: 1 })).toBe(7);
  });

  it("lowers the cap for a hole where a plus handicap gives a stroke back", () => {
    expect(adjustedGross({ 1: 9 }, pars, { 1: -1 })).toBe(5);
  });

  it("counts a hole with no par unchanged rather than guessing one", () => {
    expect(adjustedGross({ 9: 8 }, pars)).toBe(8);
  });

  it("returns zero for an empty card", () => {
    expect(adjustedGross({}, pars)).toBe(0);
  });
});

describe("simulator rounds", () => {
  /** Twenty outdoor rounds all on the same differential: an index of 12. */
  const steady = (differential: number, count = 20) =>
    Array.from({ length: count }, (_, i) => ({
      differential,
      playedOn: `2026-0${1 + Math.floor(i / 10)}-${String((i % 10) + 1).padStart(2, "0")}`,
    }));

  it("changes nothing when there are none", () => {
    const outdoor = steady(12);

    // The weight is reported either way; what matters is that it moved nothing.
    expect(indexFromDifferentials(outdoor, null, { simulatorWeight: 0.25 }).index).toBe(
      indexFromDifferentials(outdoor, null).index,
    );
  });

  it("changes nothing at full weight, which is the published method", () => {
    const mixed = [...steady(12, 19), { differential: 2, playedOn: "2026-03-01", simulator: true }];

    expect(indexFromDifferentials(mixed, null, { simulatorWeight: 1 })).toEqual(
      indexFromDifferentials(mixed, null),
    );
    expect(indexFromDifferentials(mixed, null, { simulatorWeight: 1 }).simulatorRounds).toBe(1);
  });

  it("pulls a simulator round towards what the player shoots outdoors", () => {
    // Nineteen outdoor rounds at 12, then a 2 indoors — ten shots better.
    const mixed = [...steady(12, 19), { differential: 2, playedOn: "2026-03-01", simulator: true }];

    const full = indexFromDifferentials(mixed, null, { simulatorWeight: 1 });
    const quarter = indexFromDifferentials(mixed, null, { simulatorWeight: 0.25 });

    // At full weight the 2 is the lowest differential and drags the index down.
    expect(full.index).toBeLessThan(quarter.index!);
    // At a quarter it counts as 9.5 — a quarter of the way from 12 to 2.
    expect(quarter.index).toBe(11.7);
    expect(quarter.status === "calculated" && quarter.simulatorWeight).toBe(0.25);
  });

  it("leaves it out of the record entirely at zero", () => {
    const mixed = [...steady(12, 19), { differential: 2, playedOn: "2026-03-01", simulator: true }];
    const zero = indexFromDifferentials(mixed, null, { simulatorWeight: 0 });

    expect(zero.index).toBe(12);
    expect(zero.status === "calculated" && zero.differentialsUsed).toBe(7);
    // Still posted, still reported, just not counted.
    expect(zero.roundsPosted).toBe(20);
    expect(zero.simulatorRounds).toBe(1);
  });

  it("counts a simulator round in full when there is no outdoor form to pull towards", () => {
    const indoors = [
      { differential: 8, playedOn: "2026-03-01", simulator: true },
      { differential: 10, playedOn: "2026-03-02", simulator: true },
      { differential: 12, playedOn: "2026-03-03", simulator: true },
    ];

    // No anchor and no self-reported figure: nothing to pull towards, so the
    // rounds stand as they are rather than being quietly discounted.
    expect(indexFromDifferentials(indoors, null, { simulatorWeight: 0.25 }).index).toBe(
      indexFromDifferentials(indoors, null).index,
    );
  });

  it("falls back to the self-reported figure as the anchor", () => {
    const indoors = [
      { differential: 4, playedOn: "2026-03-01", simulator: true },
      { differential: 4, playedOn: "2026-03-02", simulator: true },
      { differential: 4, playedOn: "2026-03-03", simulator: true },
    ];

    // Told they play to 20, four-shot sim rounds only move them a quarter of
    // the way: 20 + 0.25 x (4 - 20) = 16.
    const quarter = indexFromDifferentials(indoors, 20, { simulatorWeight: 0.25 });

    expect(quarter.index).toBe(14);
    expect(quarter.simulatorRounds).toBe(3);
  });

  it("reports how many were indoors even while provisional", () => {
    const two = [
      { differential: 9, playedOn: "2026-03-01", simulator: true },
      { differential: 11, playedOn: "2026-03-02" },
    ];
    const result = indexFromDifferentials(two, 14, { simulatorWeight: 0.25 });

    expect(result).toMatchObject({
      status: "provisional",
      index: 14,
      roundsPosted: 2,
      roundsNeeded: 1,
      simulatorRounds: 1,
    });
  });
});

describe("nine-hole rounds in the handicap record", () => {
  it("rates a 9-hole course's nine by its own figures", () => {
    expect(nineHoleRating(35.4, 36)).toEqual({ rating: 35.4, par: 36 });
  });

  it("halves an 18-hole course's rating and par for nine of its holes", () => {
    expect(nineHoleRating(71.2, 72)).toEqual({ rating: 35.6, par: 36 });
  });

  it("adds the expected other nine to the nine played", () => {
    // Greg, 9.8: a 39 at Practice Ridge (35.4 / 124).
    // 113/124 × (39 − 35.4) = 3.28; expected 0.52 × 9.8 + 1.2 = 6.30; 9.58 → 9.6
    expect(nineHoleDifferential(39, 35.4, 124, 9.8)).toBe(9.6);
  });

  it("doubles the nine when there's no index to expect from", () => {
    // 3.28 × 2 = 6.56 → 6.6
    expect(nineHoleDifferential(39, 35.4, 124, null)).toBe(6.6);
  });

  it("never measures nine holes against a full 18-hole rating", () => {
    // A 40 on nine holes of a 72-rated course is not a round 32 under.
    expect(nineHoleDifferential(40, nineHoleRating(72, 72).rating, 113, 10)).toBeGreaterThan(0);
  });
});

