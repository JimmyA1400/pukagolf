import { describe, expect, it } from "vitest";

import {
  netField,
  playerTee,
  playingHandicap,
  receivedStrokes,
  toNetScores,
} from "./net";

const tees = [
  { tee: "black", totalYards: 6800, courseRating: 73.1, slope: 131 },
  { tee: "blue", totalYards: 6400, courseRating: 71.2, slope: 127 },
  { tee: "white", totalYards: 6000, courseRating: 69.0, slope: 121 },
];

/** Stroke index 1..18 on holes 1..18, hardest first. */
const siInOrder = Object.fromEntries(
  Array.from({ length: 18 }, (_, i) => [i + 1, i + 1]),
);

describe("playerTee", () => {
  it("prefers the tee recorded as played", () => {
    expect(playerTee("white", "tips", tees)?.tee).toBe("white");
  });

  it("falls back to the player's preference", () => {
    expect(playerTee(null, "tips", tees)?.tee).toBe("black");
  });

  it("falls back to the longest set with no preference", () => {
    expect(playerTee(null, null, tees)?.tee).toBe("black");
  });

  it("has nothing to give for a course with no tees", () => {
    expect(playerTee(null, "mens", [])).toBeNull();
  });
});

describe("playingHandicap", () => {
  it("uses the WHS course handicap from the tee's rating and slope", () => {
    // 10 × 127/113 + (71.2 − 72) = 11.24 − 0.8 = 10.44 → 10
    expect(
      playingHandicap({ index: 10, tee: tees[1], coursePar: 72, holeCount: 18 }),
    ).toBe(10);
  });

  it("gives more on a harder course with the same index", () => {
    const easy = playingHandicap({ index: 18, tee: tees[2], coursePar: 72, holeCount: 18 });
    const hard = playingHandicap({ index: 18, tee: tees[0], coursePar: 72, holeCount: 18 });

    expect(hard!).toBeGreaterThan(easy!);
  });

  it("falls back to the index when the tee isn't rated", () => {
    expect(
      playingHandicap({
        index: 12.6,
        tee: { courseRating: null, slope: null },
        coursePar: 72,
        holeCount: 18,
      }),
    ).toBe(13);
  });

  it("halves it for nine holes", () => {
    // 10/2 × 127/113 + (71.2 − 72)/2 = 5.62 − 0.4 = 5.22 → 5
    expect(
      playingHandicap({ index: 10, tee: tees[1], coursePar: 72, holeCount: 9 }),
    ).toBe(5);
  });

  it("uses a 9-hole course's own rating and par as they are, rounding once", () => {
    // Practice Ridge: rated 35.4, slope 124, par 36, all nine holes.
    const nine = { courseRating: 35.4, slope: 124 };
    const strokes = (index: number) =>
      playingHandicap({ index, tee: nine, coursePar: 36, holeCount: 9 });

    // 3.1/2 × 124/113 + (35.4 − 36) = 1.70 − 0.6 = 1.10 → 1
    expect(strokes(3.1)).toBe(1);
    // 11.0/2 × 124/113 − 0.6 = 6.04 − 0.6 = 5.44 → 5
    expect(strokes(11)).toBe(5);
    // 22.5/2 × 124/113 − 0.6 = 12.35 − 0.6 = 11.75 → 12
    expect(strokes(22.5)).toBe(12);
    // 9.8/2 × 124/113 − 0.6 = 5.38 − 0.6 = 4.78 → 5
    expect(strokes(9.8)).toBe(5);
  });

  it("halves an unrated index for nine holes once", () => {
    expect(
      playingHandicap({ index: 12.6, tee: { courseRating: null, slope: null }, coursePar: 72, holeCount: 9 }),
    ).toBe(6);
  });

  it("keeps a plus handicap negative", () => {
    expect(
      playingHandicap({ index: -2, tee: { courseRating: null, slope: null }, coursePar: 72, holeCount: 18 }),
    ).toBe(-2);
  });

  it("leaves a player with no index out of the net game", () => {
    expect(
      playingHandicap({ index: null, tee: tees[0], coursePar: 72, holeCount: 18 }),
    ).toBeNull();
  });
});

describe("receivedStrokes", () => {
  it("gives the first strokes to the hardest holes", () => {
    const received = receivedStrokes(3, siInOrder, Array.from({ length: 18 }, (_, i) => i + 1))!;

    expect(received[1]).toBe(1);
    expect(received[3]).toBe(1);
    expect(received[4]).toBe(0);
  });

  it("re-ranks a nine so its hardest hole still gets the first stroke", () => {
    // Front nine carries the odd indexes: hole 5 is SI 1, hole 2 is SI 17.
    const front = { 1: 7, 2: 17, 3: 3, 4: 13, 5: 1, 6: 11, 7: 5, 8: 15, 9: 9 };
    const received = receivedStrokes(2, front, [1, 2, 3, 4, 5, 6, 7, 8, 9])!;

    expect(received[5]).toBe(1);
    expect(received[3]).toBe(1);
    expect(received[7]).toBe(0);
  });

  it("refuses to guess when a hole has no stroke index", () => {
    expect(receivedStrokes(10, { 1: 1, 2: 2 }, [1, 2, 3])).toBeNull();
  });
});

describe("toNetScores", () => {
  it("takes each hole's strokes off and drops players with no allocation", () => {
    const net = toNetScores(
      [
        { playerId: "a", hole: 1, strokes: 5 },
        { playerId: "a", hole: 2, strokes: 4 },
        { playerId: "b", hole: 1, strokes: 4 },
      ],
      { a: { 1: 1, 2: 0 } },
    );

    expect(net).toEqual([
      { playerId: "a", hole: 1, strokes: 4 },
      { playerId: "a", hole: 2, strokes: 4 },
    ]);
  });
});

describe("netField", () => {
  it("builds handicaps and allocations for a whole group", () => {
    const field = netField({
      players: [
        { id: "a", handicapIndex: 10, preferredTee: "mens" },
        { id: "b", handicapIndex: null, preferredTee: null },
      ],
      tees,
      coursePar: 72,
      holeCount: 18,
      strokeIndexes: siInOrder,
    });

    expect(field.available).toBe(true);
    expect(field.withoutIndex).toEqual(["b"]);
    expect(Object.values(field.received.a).reduce((x, y) => x + y, 0)).toBe(
      field.handicaps.a,
    );
  });

  it("says net isn't available when the course has no stroke indexes", () => {
    const field = netField({
      players: [{ id: "a", handicapIndex: 10, preferredTee: null }],
      tees,
      coursePar: 72,
      holeCount: 18,
      strokeIndexes: {},
    });

    expect(field.available).toBe(false);
  });
});

describe("Practice Ridge, a 9-hole course rated 35.4 / 124, par 36", () => {
  it("gives Lou 1, Mo 12 and Sal 5, as WHS does", () => {
    const field = netField({
      players: [
        { id: "lou", handicapIndex: 3.1, preferredTee: null },
        { id: "mo", handicapIndex: 22.5, preferredTee: null },
        { id: "sal", handicapIndex: 11.0, preferredTee: null },
      ],
      tees: [{ tee: "white", totalYards: 3120, courseRating: 35.4, slope: 124 }],
      coursePar: 36,
      holeCount: 9,
      strokeIndexes: { 1: 5, 2: 1, 3: 9, 4: 3, 5: 7, 6: 2, 7: 8, 8: 6, 9: 4 },
    });

    expect(field.handicaps).toEqual({ lou: 1, mo: 12, sal: 5 });
  });
});

