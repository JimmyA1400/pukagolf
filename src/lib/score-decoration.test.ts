import { describe, expect, it } from "vitest";

import {
  describeScore,
  isRound,
  ringCount,
  scoreDecoration,
} from "./score-decoration";

describe("scoreDecoration", () => {
  it.each([
    // [strokes, par, expected]
    [2, 4, "double-circle"], // eagle
    [1, 4, "double-circle"], // albatross, still a double circle
    [1, 3, "double-circle"], // hole in one on a par 3 is an eagle
    [3, 4, "circle"], // birdie
    [4, 4, "none"], // par
    [5, 4, "box"], // bogey
    [6, 4, "double-box"], // double bogey
    [7, 4, "triple-box"], // triple bogey
    [10, 4, "triple-box"], // worse than triple still caps at three rings
  ])("marks %i on a par %i as %s", (strokes, par, expected) => {
    expect(scoreDecoration(strokes, par)).toBe(expected);
  });

  it("works the same on a par 5", () => {
    expect(scoreDecoration(3, 5)).toBe("double-circle");
    expect(scoreDecoration(4, 5)).toBe("circle");
    expect(scoreDecoration(5, 5)).toBe("none");
    expect(scoreDecoration(6, 5)).toBe("box");
  });

  it("leaves an unplayed hole undecorated", () => {
    expect(scoreDecoration(null, 4)).toBe("none");
    expect(scoreDecoration(undefined, 4)).toBe("none");
  });

  it("leaves a hole with no par undecorated", () => {
    // Guessing par 4 would mark scores as bogeys that aren't.
    expect(scoreDecoration(5, null)).toBe("none");
    expect(scoreDecoration(5, undefined)).toBe("none");
    expect(scoreDecoration(5, 0)).toBe("none");
  });
});

describe("ringCount", () => {
  it("counts rings per decoration", () => {
    expect(ringCount("none")).toBe(0);
    expect(ringCount("circle")).toBe(1);
    expect(ringCount("box")).toBe(1);
    expect(ringCount("double-circle")).toBe(2);
    expect(ringCount("double-box")).toBe(2);
    expect(ringCount("triple-box")).toBe(3);
  });

  it("gives worse scores more rings", () => {
    const rings = (s: number) => ringCount(scoreDecoration(s, 4));

    expect(rings(5)).toBeLessThan(rings(6));
    expect(rings(6)).toBeLessThan(rings(7));
  });
});

describe("isRound", () => {
  it("is true only for under-par decorations", () => {
    expect(isRound("circle")).toBe(true);
    expect(isRound("double-circle")).toBe(true);
    expect(isRound("box")).toBe(false);
    expect(isRound("double-box")).toBe(false);
    expect(isRound("triple-box")).toBe(false);
    expect(isRound("none")).toBe(false);
  });
});

describe("describeScore", () => {
  it.each([
    [2, 4, "2, eagle"],
    [3, 4, "3, birdie"],
    [4, 4, "4, par"],
    [5, 4, "5, bogey"],
    [6, 4, "6, double bogey"],
    [7, 4, "7, triple bogey"],
    [1, 4, "1, albatross"],
  ])("describes %i on a par %i", (strokes, par, expected) => {
    expect(describeScore(strokes, par)).toBe(expected);
  });

  it("counts beyond triple rather than inventing a name", () => {
    expect(describeScore(9, 4)).toBe("9, 5 over par");
  });

  it("gives the bare number when par is unknown", () => {
    expect(describeScore(5, null)).toBe("5");
  });

  it("says nothing for an unplayed hole", () => {
    expect(describeScore(null, 4)).toBeNull();
  });

  it("agrees with the decoration about which shape to draw", () => {
    // The words and the shape must never disagree about the same score.
    for (const strokes of [1, 2, 3, 4, 5, 6, 7, 9]) {
      const words = describeScore(strokes, 4)!;
      const round = isRound(scoreDecoration(strokes, 4));

      const soundsUnderPar = /albatross|eagle|birdie/.test(words);
      expect(round).toBe(soundsUnderPar);
    }
  });
});
