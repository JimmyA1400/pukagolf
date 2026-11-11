import { describe, expect, it } from "vitest";

import {
  buildRotation,
  InvalidGroupError,
  reseedAfterDropout,
  scoredBy,
  type Assignment,
} from "./rotation";

/** Assignments as "scorer>scored" pairs, for readable expectations. */
const pairs = (assignments: Assignment[]) =>
  assignments.map((a) => `${a.scorerId}>${a.scoredId}`);

describe("buildRotation", () => {
  it("wraps the last player around to the first", () => {
    expect(pairs(buildRotation(["P1", "P2", "P3", "P4"]))).toEqual([
      "P1>P2",
      "P2>P3",
      "P3>P4",
      "P4>P1",
    ]);
  });

  it("handles a threesome", () => {
    expect(pairs(buildRotation(["P1", "P2", "P3"]))).toEqual([
      "P1>P2",
      "P2>P3",
      "P3>P1",
    ]);
  });

  it("handles a twosome as a mutual pair", () => {
    expect(pairs(buildRotation(["P1", "P2"]))).toEqual(["P1>P2", "P2>P1"]);
  });

  it("is generic in group size, not hardcoded to four", () => {
    for (const size of [2, 3, 4, 5, 6, 12]) {
      const players = Array.from({ length: size }, (_, i) => `P${i}`);
      const rotation = buildRotation(players);

      expect(rotation).toHaveLength(size);
      // Everyone scores exactly once and is scored exactly once: a true ring.
      expect(new Set(rotation.map((a) => a.scorerId)).size).toBe(size);
      expect(new Set(rotation.map((a) => a.scoredId)).size).toBe(size);
      expect(rotation.every((a) => a.scorerId !== a.scoredId)).toBe(true);
    }
  });

  it("refuses a group of one, which would point a player at themselves", () => {
    expect(() => buildRotation(["P1"])).toThrow(InvalidGroupError);
  });

  it("refuses an empty group", () => {
    expect(() => buildRotation([])).toThrow(InvalidGroupError);
  });

  it("refuses a group containing the same player twice", () => {
    expect(() => buildRotation(["P1", "P2", "P1"])).toThrow(InvalidGroupError);
  });
});

describe("reseedAfterDropout", () => {
  const foursome = ["P1", "P2", "P3", "P4"];

  it("re-closes both edges the dropout broke", () => {
    // P2 leaving strands P1 (no card to keep) and P3 (nobody keeping theirs).
    const repaired = reseedAfterDropout(foursome, ["P2"]);

    expect(pairs(repaired)).toEqual(["P1>P3", "P3>P4", "P4>P1"]);
  });

  it("leaves no assignment referencing the departed player", () => {
    const repaired = reseedAfterDropout(foursome, ["P2"]);

    expect(
      repaired.some((a) => a.scorerId === "P2" || a.scoredId === "P2"),
    ).toBe(false);
  });

  it("preserves relative order so the repair stays minimal", () => {
    expect(pairs(reseedAfterDropout(foursome, ["P3"]))).toEqual([
      "P1>P2",
      "P2>P4",
      "P4>P1",
    ]);
  });

  it("handles two players leaving at once", () => {
    expect(pairs(reseedAfterDropout(foursome, ["P2", "P4"]))).toEqual([
      "P1>P3",
      "P3>P1",
    ]);
  });

  it("refuses to leave a single player scoring themselves", () => {
    expect(() => reseedAfterDropout(foursome, ["P2", "P3", "P4"])).toThrow(
      InvalidGroupError,
    );
  });

  it("ignores a dropout who was never in the group", () => {
    expect(pairs(reseedAfterDropout(foursome, ["P9"]))).toEqual(
      pairs(buildRotation(foursome)),
    );
  });
});

describe("scoredBy", () => {
  const rotation = buildRotation(["P1", "P2", "P3", "P4"]);

  it("returns the one player a scorer is responsible for", () => {
    expect(scoredBy(rotation, "P3")).toBe("P4");
  });

  it("returns null for someone holding no assignment", () => {
    expect(scoredBy(rotation, "P9")).toBeNull();
  });
});
