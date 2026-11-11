import { describe, expect, it } from "vitest";

import {
  buildLeaderboard,
  formatToPar,
  isTied,
  placeLabel,
  type Score,
} from "./leaderboard";

/** Par 4 on every hole, so expectations stay easy to read. */
const PARS = Object.fromEntries(
  Array.from({ length: 18 }, (_, i) => [i + 1, 4]),
);

/** n holes of the given strokes each. */
const card = (playerId: string, holes: number, strokes: number): Score[] =>
  Array.from({ length: holes }, (_, i) => ({
    playerId,
    hole: i + 1,
    strokes,
  }));

describe("buildLeaderboard", () => {
  it("totals gross strokes and counts holes played", () => {
    const board = buildLeaderboard(card("P1", 9, 5), ["P1"]);

    expect(board[0]).toMatchObject({ playerId: "P1", strokes: 45, thru: 9 });
  });

  it("ranks the lower total first", () => {
    const scores = [...card("P1", 9, 5), ...card("P2", 9, 4)];
    const board = buildLeaderboard(scores, ["P1", "P2"]);

    expect(board.map((e) => e.playerId)).toEqual(["P2", "P1"]);
  });

  it("includes players who have not teed off, ranked last", () => {
    const board = buildLeaderboard(card("P1", 3, 4), ["P1", "P2"]);

    expect(board.map((e) => e.playerId)).toEqual(["P1", "P2"]);
    expect(board[1]).toMatchObject({ strokes: 0, thru: 0 });
  });

  it("ignores scores for players outside the field", () => {
    const scores = [...card("P1", 2, 4), ...card("STRANGER", 2, 2)];
    const board = buildLeaderboard(scores, ["P1"]);

    expect(board).toHaveLength(1);
    expect(board[0].strokes).toBe(8);
  });

  describe("with par data", () => {
    it("compares players fairly across different holes played", () => {
      // P1 is +4 thru 9; P2 is +6 thru 18. P1 leads despite the smaller total.
      const scores = [
        ...card("P1", 9, 4), // 36 strokes, level par
        ...card("P2", 18, 5), // 90 strokes, +18
      ];
      const board = buildLeaderboard(scores, ["P1", "P2"], { pars: PARS });

      expect(board.map((e) => e.playerId)).toEqual(["P1", "P2"]);
      expect(board[0]).toMatchObject({ toPar: 0, thru: 9 });
      expect(board[1]).toMatchObject({ toPar: 18, thru: 18 });
    });

    it("breaks a tie on par toward whoever has played further", () => {
      const scores = [...card("P1", 9, 4), ...card("P2", 18, 4)];
      const board = buildLeaderboard(scores, ["P1", "P2"], { pars: PARS });

      expect(board.map((e) => e.playerId)).toEqual(["P2", "P1"]);
    });
  });

  describe("without par data", () => {
    it("reports toPar as null", () => {
      const board = buildLeaderboard(card("P1", 9, 4), ["P1"]);

      expect(board[0].toPar).toBeNull();
    });

    it("sorts on raw total, which mid-round favours the player thru fewer holes", () => {
      // Documents the limitation the `pars` option exists to fix: P1 has played
      // half a round and "leads" on strokes alone.
      const scores = [...card("P1", 9, 5), ...card("P2", 18, 4)];
      const board = buildLeaderboard(scores, ["P1", "P2"]);

      expect(board.map((e) => e.playerId)).toEqual(["P1", "P2"]);
      expect(board[0].strokes).toBeLessThan(board[1].strokes);
    });
  });

  describe("formatToPar", () => {
    it("shows level par as E", () => {
      expect(formatToPar(0)).toBe("E");
    });

    it("signs over-par scores", () => {
      expect(formatToPar(3)).toBe("+3");
    });

    it("signs under-par scores", () => {
      expect(formatToPar(-2)).toBe("-2");
    });

    it("returns null without par data, so callers fall back to strokes", () => {
      expect(formatToPar(null)).toBeNull();
    });

    it("reads a live card the way a golfer would", () => {
      // Three pars and a bogey on par-4 holes: +1 through 4.
      const scores: Score[] = [
        { playerId: "P1", hole: 1, strokes: 4 },
        { playerId: "P1", hole: 2, strokes: 4 },
        { playerId: "P1", hole: 3, strokes: 5 },
        { playerId: "P1", hole: 4, strokes: 4 },
      ];
      const [entry] = buildLeaderboard(scores, ["P1"], { pars: PARS });

      expect(formatToPar(entry.toPar)).toBe("+1");
      expect(entry.thru).toBe(4);
    });
  });

  describe("positions", () => {
    it("gives tied players the same position and skips the slots below", () => {
      const scores = [
        ...card("P1", 9, 4), // 36
        ...card("P2", 9, 5), // 45
        ...card("P3", 9, 5), // 45
        ...card("P4", 9, 6), // 54
      ];
      const board = buildLeaderboard(scores, ["P1", "P2", "P3", "P4"]);

      expect(board.map((e) => e.position)).toEqual([1, 2, 2, 4]);
    });

    it("reports which positions are shared", () => {
      const scores = [
        ...card("P1", 9, 4),
        ...card("P2", 9, 5),
        ...card("P3", 9, 5),
      ];
      const board = buildLeaderboard(scores, ["P1", "P2", "P3"]);

      expect(isTied(board, 1)).toBe(false);
      expect(isTied(board, 2)).toBe(true);
    });
  });
});

describe("ties", () => {
  it("are level on the score, whatever the holes played", () => {
    // P1 -2 thru 9, P2 -2 thru 4, P3 -1 thru 4: places 1, 1, 3.
    const scores = [
      ...card("P1", 7, 4),
      { playerId: "P1", hole: 8, strokes: 3 },
      { playerId: "P1", hole: 9, strokes: 3 },
      ...card("P2", 2, 4),
      { playerId: "P2", hole: 3, strokes: 3 },
      { playerId: "P2", hole: 4, strokes: 3 },
      ...card("P3", 3, 4),
      { playerId: "P3", hole: 4, strokes: 3 },
    ];
    const board = buildLeaderboard(scores, ["P1", "P2", "P3"], { pars: PARS });

    expect(board.map((e) => [e.playerId, e.position])).toEqual([
      ["P1", 1],
      ["P2", 1],
      ["P3", 3],
    ]);
    expect(placeLabel(1, board.map((e) => e.position))).toBe("T1");
    expect(placeLabel(3, board.map((e) => e.position))).toBe("3");
  });

  it("never put somebody who hasn't started level with somebody at even par", () => {
    const board = buildLeaderboard(card("P1", 3, 4), ["P1", "P2"], { pars: PARS });

    expect(board.map((e) => e.position)).toEqual([1, 2]);
  });
});

