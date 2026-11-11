import { describe, expect, it } from "vitest";

import { positionsFromGross } from "./tournament-positions";

const rows = (scores: (number | null)[]) =>
  scores.map((gross, i) => ({ playerId: `p${i + 1}`, gross }));

describe("positionsFromGross", () => {
  it("ranks lowest score first", () => {
    expect(positionsFromGross(rows([78, 74, 81]))).toEqual({
      p2: 1,
      p1: 2,
      p3: 3,
    });
  });

  it("gives tied players the same position", () => {
    expect(positionsFromGross(rows([74, 74, 80]))).toEqual({
      p1: 1,
      p2: 1,
      p3: 3,
    });
  });

  it("skips the places a tie consumes", () => {
    // Two tied for second means nobody finishes third.
    const positions = positionsFromGross(rows([70, 75, 75, 80]));

    expect(positions).toEqual({ p1: 1, p2: 2, p3: 2, p4: 4 });
  });

  it("leaves players with no score unranked", () => {
    // Entered but did not finish: ranking them would put a blank card first.
    const positions = positionsFromGross(rows([74, null, 80]));

    expect(positions).toEqual({ p1: 1, p3: 2 });
    expect(positions.p2).toBeUndefined();
  });

  it("handles everyone tied", () => {
    expect(positionsFromGross(rows([72, 72, 72]))).toEqual({
      p1: 1,
      p2: 1,
      p3: 1,
    });
  });

  it("returns nothing for an empty field", () => {
    expect(positionsFromGross([])).toEqual({});
  });

  it("returns nothing when nobody posted a score", () => {
    expect(positionsFromGross(rows([null, null]))).toEqual({});
  });
});
