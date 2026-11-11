import { describe, expect, it } from "vitest";

import {
  buildGameBoard,
  formatGameScore,
  getGame,
  parseStablefordTable,
  sidesFor,
  stablefordPoints,
} from "./games";
import { buildLeaderboard, type Score } from "./leaderboard";

const PARS = { 1: 4, 2: 3, 3: 5, 4: 4 };
const HOLES = 4;

function card(playerId: string, strokes: readonly number[]): Score[] {
  return strokes.map((s, i) => ({ playerId, hole: i + 1, strokes: s }));
}

const solo = (ids: readonly string[]) => ids.map((id) => ({ id, playerIds: [id] }));

describe("getGame", () => {
  it("falls back to stroke play for a week whose game predates games", () => {
    expect(getGame(null).id).toBe("stroke");
    expect(getGame("skins-night").id).toBe("stroke");
    expect(getGame("scramble").sharedBall).toBe(true);
  });
});

describe("stablefordPoints", () => {
  it("scores the standard table off par", () => {
    expect(stablefordPoints(2, 4)).toBe(4); // eagle
    expect(stablefordPoints(3, 4)).toBe(3); // birdie
    expect(stablefordPoints(4, 4)).toBe(2); // par
    expect(stablefordPoints(5, 4)).toBe(1); // bogey
    expect(stablefordPoints(6, 4)).toBe(0); // double
  });

  it("caps both ends, so a hole that got away costs a fixed amount", () => {
    expect(stablefordPoints(1, 5)).toBe(5); // albatross
    expect(stablefordPoints(1, 6)).toBe(5); // better still, same points
    expect(stablefordPoints(9, 4)).toBe(0);
    expect(stablefordPoints(12, 4)).toBe(0);
  });

  it("takes a modified table, where a wreck actually costs points", () => {
    const modified = [8, 5, 2, 0, -1, -3];

    expect(stablefordPoints(3, 4, modified)).toBe(2);
    expect(stablefordPoints(4, 4, modified)).toBe(0);
    expect(stablefordPoints(7, 4, modified)).toBe(-3);
  });
});

describe("parseStablefordTable", () => {
  it("takes six numbers", () => {
    expect(parseStablefordTable("8, 5, 2, 0, -1, -3")).toEqual({
      ok: true,
      value: [8, 5, 2, 0, -1, -3],
    });
  });

  it("says what is wrong", () => {
    expect(parseStablefordTable("5 4 3")).toMatchObject({ ok: false });
    expect(parseStablefordTable("5 4 3 2 1 x")).toMatchObject({ ok: false });
    expect(parseStablefordTable("5 4 3 2 0 1")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("worse hole"),
    });
  });
});

describe("sidesFor", () => {
  const groups = [
    { id: "g1", playerIds: ["a", "b"] },
    { id: "g2", playerIds: ["c"] },
  ];

  it("gives an individual game a side per player", () => {
    expect(sidesFor("stableford", ["a", "b", "c"], groups)).toEqual([
      { id: "a", playerIds: ["a"] },
      { id: "b", playerIds: ["b"] },
      { id: "c", playerIds: ["c"] },
    ]);
  });

  it("gives a team game a side per tee time", () => {
    expect(sidesFor("scramble", ["a", "b", "c"], groups)).toEqual([
      { id: "g1", playerIds: ["a", "b"] },
      { id: "g2", playerIds: ["c"] },
    ]);
  });

  it("keeps a player who was never put in a group", () => {
    expect(sidesFor("best_ball", ["a", "b", "c", "d"], groups)).toContainEqual({
      id: "d",
      playerIds: ["d"],
    });
  });

  it("leaves out a side whose players aren't in the field", () => {
    expect(sidesFor("scramble", ["a", "b"], groups)).toEqual([
      { id: "g1", playerIds: ["a", "b"] },
    ]);
  });
});

describe("buildGameBoard", () => {
  it("orders stroke play exactly as the plain leaderboard does", () => {
    const scores = [...card("a", [4, 3, 6, 4]), ...card("b", [5, 3, 5, 4]), ...card("c", [4, 3])];
    const ids = ["a", "b", "c"];

    const board = buildGameBoard({
      game: "stroke",
      sides: solo(ids),
      scores,
      pars: PARS,
      holeCount: HOLES,
    });
    const plain = buildLeaderboard(scores, ids, { pars: PARS });

    expect(board.map((r) => [r.id, r.position, r.toPar, r.thru])).toEqual(
      plain.map((e) => [e.playerId, e.position, e.toPar, e.thru]),
    );
  });

  it("ranks Stableford by points, highest first", () => {
    // a goes round level. b is three over — three birdies and a 10 that costs
    // the hole and no more — and wins the week the league is actually playing.
    const scores = [...card("a", [4, 3, 5, 4]), ...card("b", [3, 2, 4, 10])];

    const stroke = buildGameBoard({
      game: "stroke",
      sides: solo(["a", "b"]),
      scores,
      pars: PARS,
      holeCount: HOLES,
    });
    expect(stroke.map((r) => r.id)).toEqual(["a", "b"]);

    const board = buildGameBoard({
      game: "stableford",
      sides: solo(["a", "b"]),
      scores,
      pars: PARS,
      holeCount: HOLES,
    });

    expect(board.map((r) => [r.id, r.points])).toEqual([
      ["b", 9],
      ["a", 8],
    ]);
    expect(board[0].position).toBe(1);
    expect(formatGameScore(board[0], "stableford")).toBe("9");
  });

  it("has no points at all without pars to count them against", () => {
    const board = buildGameBoard({
      game: "stableford",
      sides: solo(["a"]),
      scores: card("a", [4]),
      holeCount: HOLES,
    });

    expect(board[0].points).toBeNull();
    expect(formatGameScore(board[0], "stableford")).toBe("4");
  });

  it("counts a scramble hole once, from the one ball the side played", () => {
    const board = buildGameBoard({
      game: "scramble",
      sides: [{ id: "g1", playerIds: ["a", "b", "c"] }],
      scores: [
        { playerId: "a", hole: 1, strokes: 4 },
        { playerId: "b", hole: 1, strokes: 4 },
        { playerId: "c", hole: 1, strokes: 4 },
      ],
      pars: PARS,
      holeCount: HOLES,
    });

    expect(board[0]).toMatchObject({ strokes: 4, thru: 1, toPar: 0 });
  });

  it("holds a best-ball hole until the whole side has posted it", () => {
    const sides = [{ id: "g1", playerIds: ["a", "b", "c"] }];
    const posted: Score[] = [
      { playerId: "a", hole: 1, strokes: 3 },
      { playerId: "b", hole: 1, strokes: 5 },
    ];

    const waiting = buildGameBoard({
      game: "best_ball",
      sides,
      scores: posted,
      pars: PARS,
      holeCount: HOLES,
    });
    expect(waiting[0]).toMatchObject({ thru: 0, strokes: 0 });

    const complete = buildGameBoard({
      game: "best_ball",
      sides,
      scores: [...posted, { playerId: "c", hole: 1, strokes: 6 }],
      pars: PARS,
      holeCount: HOLES,
    });
    expect(complete[0]).toMatchObject({ thru: 1, strokes: 3, toPar: -1 });
  });

  it("scores a threesome and a foursome against each other on their own holes", () => {
    const board = buildGameBoard({
      game: "best_ball",
      sides: [
        { id: "three", playerIds: ["a", "b", "c"] },
        { id: "four", playerIds: ["d", "e", "f", "g"] },
      ],
      scores: [
        ...["a", "b", "c"].flatMap((id) => card(id, [5, 4, 6, 5])),
        ...["d", "e", "f", "g"].flatMap((id) => card(id, [4, 3, 5, 4])),
      ],
      pars: PARS,
      holeCount: HOLES,
    });

    expect(board.map((r) => [r.id, r.toPar])).toEqual([
      ["four", 0],
      ["three", 4],
    ]);
  });

  it("counts a back-nine week on holes 10 to 18", () => {
    const pars = { 10: 4, 11: 3 };
    const board = buildGameBoard({
      game: "stableford",
      sides: solo(["a"]),
      scores: [
        { playerId: "a", hole: 10, strokes: 3 },
        { playerId: "a", hole: 11, strokes: 3 },
      ],
      pars,
      holeCount: 2,
      startHole: 10,
    });

    expect(board[0]).toMatchObject({ thru: 2, points: 5, holes: { 10: 3, 11: 3 } });
  });

  it("shares a position between tied sides", () => {
    const board = buildGameBoard({
      game: "stableford",
      sides: solo(["a", "b", "c"]),
      scores: [...card("a", [4]), ...card("b", [4]), ...card("c", [5])],
      pars: PARS,
      holeCount: HOLES,
    });

    expect(board.map((r) => r.position)).toEqual([1, 1, 3]);
  });
});

describe("ties on the game board", () => {
  it("share a place on the score alone, gross and net alike", () => {
    const pars = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, 4]));
    const scores = [
      ...Array.from({ length: 9 }, (_, i) => ({ playerId: "pat", hole: i + 1, strokes: i < 2 ? 3 : 4 })),
      ...Array.from({ length: 4 }, (_, i) => ({ playerId: "greg", hole: i + 1, strokes: i < 2 ? 3 : 4 })),
    ];
    const board = buildGameBoard({
      game: "stroke",
      sides: sidesFor("stroke", ["pat", "greg"], []),
      scores,
      pars,
      holeCount: 9,
    });

    expect(board.map((row) => [row.id, row.toPar, row.position])).toEqual([
      ["pat", -2, 1],
      ["greg", -2, 1],
    ]);
  });
});

