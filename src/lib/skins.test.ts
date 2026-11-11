import { describe, expect, it } from "vitest";

import type { Score } from "./leaderboard";
import type { CoursePars } from "./scorecard";
import { playSkins, totalAwarded } from "./skins";

const PARS: CoursePars = Object.fromEntries(
  Array.from({ length: 18 }, (_, i) => [i + 1, 4]),
);

const PLAYERS = ["marcus", "priya", "jreyes"];

/** One hole's worth of scores, in player order. */
const hole = (n: number, ...strokes: number[]): Score[] =>
  strokes.map((s, i) => ({ playerId: PLAYERS[i], hole: n, strokes: s }));

const game = (scores: Score[], stake = 20) =>
  playSkins(scores, PLAYERS, { stake, pars: PARS });

describe("playSkins", () => {
  it("awards the pot to an outright low score", () => {
    const g = game(hole(1, 3, 4, 5));

    expect(g.holes[0]).toMatchObject({
      status: "won",
      winnerId: "marcus",
      pot: 20,
    });
    expect(g.winnings.marcus).toBe(20);
  });

  it("names the winning score", () => {
    const g = game(hole(1, 3, 4, 5));

    expect(g.holes[0].result).toBe("birdie");
  });

  it("carries when the low score is tied", () => {
    const g = game(hole(1, 3, 3, 5));

    expect(g.holes[0]).toMatchObject({ status: "carried", winnerId: null });
    expect(totalAwarded(g)).toBe(0);
    expect(g.carrying).toBe(20);
  });

  it("adds the carry to the next hole's pot", () => {
    const g = game([...hole(1, 3, 3, 5), ...hole(2, 4, 3, 5)]);

    expect(g.holes[1]).toMatchObject({
      status: "won",
      winnerId: "priya",
      pot: 40,
    });
    expect(g.winnings.priya).toBe(40);
  });

  it("carries repeatedly, stacking the pot", () => {
    const g = game([
      ...hole(1, 4, 4, 5), // tie
      ...hole(2, 5, 5, 5), // tie
      ...hole(3, 3, 4, 4), // marcus takes 3 holes' worth
    ]);

    expect(g.holes[2].pot).toBe(60);
    expect(g.winnings.marcus).toBe(60);
    expect(g.carrying).toBe(0);
  });

  it("treats a hole as in progress until everyone has a score", () => {
    const scores: Score[] = [
      { playerId: "marcus", hole: 1, strokes: 3 },
      { playerId: "priya", hole: 1, strokes: 4 },
      // jreyes still putting
    ];
    const g = game(scores);

    expect(g.holes[0]).toMatchObject({ status: "in_progress", pot: 20 });
    expect(totalAwarded(g)).toBe(0);
  });

  it("shows a carry riding on the hole in progress", () => {
    const scores: Score[] = [
      ...hole(1, 4, 4, 5), // tie, carries
      { playerId: "marcus", hole: 2, strokes: 3 },
    ];
    const g = game(scores);

    expect(g.holes[1]).toMatchObject({ status: "in_progress", pot: 40 });
  });

  it("stops at the first unplayed hole rather than listing the course", () => {
    const g = game([...hole(1, 4, 5, 5), ...hole(2, 4, 4, 4)]);

    expect(g.holes).toHaveLength(2);
  });

  it("ignores players who are not in the game", () => {
    const scores: Score[] = [
      ...hole(1, 3, 4, 5),
      { playerId: "outsider", hole: 1, strokes: 2 },
    ];
    const g = game(scores);

    // The outsider's 2 would otherwise have stolen the skin.
    expect(g.holes[0].winnerId).toBe("marcus");
  });

  it("keeps a running total per player across the round", () => {
    const g = game([
      ...hole(1, 3, 4, 5), // marcus
      ...hole(2, 5, 3, 4), // priya
      ...hole(3, 4, 4, 3), // jreyes
    ]);

    expect(g.winnings).toEqual({ marcus: 20, priya: 20, jreyes: 20 });
    expect(totalAwarded(g)).toBe(60);
  });
});
