import { describe, expect, it } from "vitest";

import { filterTees, filterYardages, isRecognisedTee } from "./tees";

describe("isRecognisedTee", () => {
  it.each([
    "white",
    "Blue",
    "GOLD",
    "red",
    "black",
    "green",
    "silver",
  ])("accepts the colour %s", (name) => {
    expect(isRecognisedTee(name)).toBe(true);
  });

  it.each([
    "championship",
    "tips",
    "forward",
    "senior",
    "ladies",
    "member",
  ])("accepts the descriptor %s", (name) => {
    expect(isRecognisedTee(name)).toBe(true);
  });

  it("accepts combined sets", () => {
    // Courses really do mark a combined set, and the source publishes them.
    expect(isRecognisedTee("blue/white")).toBe(true);
    expect(isRecognisedTee("white/gold")).toBe(true);
  });

  it("accepts gendered tee keys", () => {
    expect(isRecognisedTee("blue-male")).toBe(true);
    expect(isRecognisedTee("red-female")).toBe(true);
  });

  it.each(["I", "II", "III", "IV", "V", "1", "2", "3"])(
    "accepts the numbered tee %s",
    (name) => {
      // Real courses number their tees instead of colouring them. An earlier
      // version of this list omitted these and would have wiped the tee
      // structure of most courses already imported.
      expect(isRecognisedTee(name)).toBe(true);
    },
  );

  it("accepts combined numbered sets", () => {
    expect(isRecognisedTee("I/II")).toBe(true);
    expect(isRecognisedTee("IV/V")).toBe(true);
  });

  it("rejects 'web', which the source publishes as a tee on real courses", () => {
    expect(isRecognisedTee("web")).toBe(false);
  });

  it.each(["unknown", "n/a", "null", "default", "-", "", "   ", "12345", "x"])(
    "rejects the junk value %j",
    (name) => {
      expect(isRecognisedTee(name)).toBe(false);
    },
  );

  it("rejects a compound where any part is junk", () => {
    // "blue" alone would pass; the whole name must be tee vocabulary.
    expect(isRecognisedTee("blue/web")).toBe(false);
  });

  it("ignores surrounding whitespace", () => {
    expect(isRecognisedTee("  white  ")).toBe(true);
  });
});

describe("filterYardages", () => {
  it("drops unrecognised tee keys and keeps the rest", () => {
    expect(
      filterYardages({ white: 350, blue: 380, web: 999, unknown: 1 }),
    ).toEqual({ white: 350, blue: 380 });
  });

  it("keeps an empty map empty", () => {
    expect(filterYardages({})).toEqual({});
  });

  it("leaves a clean map untouched", () => {
    const clean = { white: 350, "blue/white": 365 };

    expect(filterYardages(clean)).toEqual(clean);
  });
});

describe("filterTees", () => {
  const tees = [
    { tee_name: "White", yardage: 6058 },
    { tee_name: "Web", yardage: 0 },
    { tee_name: "Blue", yardage: 6400 },
  ];

  it("separates recognised tees from junk", () => {
    const { kept, dropped } = filterTees(tees, (t) => t.tee_name);

    expect(kept.map((t) => t.tee_name)).toEqual(["White", "Blue"]);
    expect(dropped).toEqual(["Web"]);
  });

  it("reports nothing dropped for a clean list", () => {
    const { dropped } = filterTees(
      [{ tee_name: "Gold", yardage: 5500 }],
      (t) => t.tee_name,
    );

    expect(dropped).toEqual([]);
  });

  it("handles an empty list", () => {
    expect(filterTees([], (t: { tee_name: string }) => t.tee_name)).toEqual({
      kept: [],
      dropped: [],
    });
  });
});
