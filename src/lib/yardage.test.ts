import { describe, expect, it } from "vitest";

import {
  availableTees,
  coverage,
  defaultTee,
  preferredTee,
  teeLabel,
  teeOptions,
  yardageTotals,
} from "./yardage";

const hole = (n: number, yardages: Record<string, number>) => ({
  hole: n,
  yardages,
});

/** Eighteen holes, every tee complete. */
const fullCourse = Array.from({ length: 18 }, (_, i) =>
  hole(i + 1, { white: 350, blue: 380, red: 300, black: 410 }),
);

describe("availableTees", () => {
  it("lists every tee that appears", () => {
    expect(availableTees(fullCourse).sort()).toEqual([
      "black",
      "blue",
      "red",
      "white",
    ]);
  });

  it("orders a more complete set ahead of a patchy one", () => {
    const patchy = [
      hole(1, { white: 350, gold: 300 }),
      hole(2, { white: 340 }),
      hole(3, { white: 360 }),
    ];

    expect(availableTees(patchy)[0]).toBe("white");
  });

  it("ignores zero and non-numeric yardages", () => {
    const holes = [hole(1, { white: 350, blue: 0 })];

    expect(availableTees(holes)).toEqual(["white"]);
  });

  it("returns nothing when the course has no yardages", () => {
    expect(availableTees([hole(1, {})])).toEqual([]);
  });
});

describe("preferredTee", () => {
  it("defaults to a middle tee rather than the tips", () => {
    // Showing the back tees by default puts the least representative number
    // on most scorecards.
    expect(preferredTee(fullCourse)).toBe("white");
  });

  it("falls to the next preference when white is absent", () => {
    const holes = Array.from({ length: 9 }, (_, i) =>
      hole(i + 1, { blue: 380, red: 300 }),
    );

    expect(preferredTee(holes)).toBe("blue");
  });

  it("prefers coverage over the preference order", () => {
    // "white" is the preferred name but covers one hole; "red" covers three.
    const holes = [
      hole(1, { white: 350, red: 300 }),
      hole(2, { red: 310 }),
      hole(3, { red: 320 }),
    ];

    expect(preferredTee(holes)).toBe("red");
  });

  it("handles an unknown tee name", () => {
    expect(preferredTee([hole(1, { championship: 400 })])).toBe("championship");
  });

  it("returns null when there are no yardages at all", () => {
    expect(preferredTee([hole(1, {}), hole(2, {})])).toBeNull();
  });
});

describe("coverage", () => {
  it("counts holes carrying a yardage for the tee", () => {
    const holes = [hole(1, { white: 350 }), hole(2, {}), hole(3, { white: 1 })];

    expect(coverage(holes, "white")).toBe(2);
  });

  it("is zero for a tee nobody has", () => {
    expect(coverage(fullCourse, "purple")).toBe(0);
  });
});

describe("yardageTotals", () => {
  it("splits at the turn", () => {
    expect(yardageTotals(fullCourse, "white")).toEqual({
      out: 9 * 350,
      in: 9 * 350,
      total: 18 * 350,
    });
  });

  it("treats a missing hole as zero rather than NaN", () => {
    const holes = [hole(1, { white: 350 }), hole(2, {})];

    expect(yardageTotals(holes, "white").total).toBe(350);
  });

  it("returns zeroes when no tee is selected", () => {
    expect(yardageTotals(fullCourse, null)).toEqual({ out: 0, in: 0, total: 0 });
  });

  it("sorts holes before splitting, so order in does not matter", () => {
    const shuffled = [...fullCourse].reverse();

    expect(yardageTotals(shuffled, "white")).toEqual(
      yardageTotals(fullCourse, "white"),
    );
  });
});

describe("teeOptions", () => {
  it("offers a rated tee even when no hole has a yardage for it", () => {
    // Practice Ridge: nine holes entered by hand, one rated tee.
    const holes = Array.from({ length: 9 }, (_, i) => ({ hole: i + 1, yardages: {} }));
    const options = teeOptions(holes, [
      { tee: "white", courseRating: 35.4, slope: 124, statedYardage: 3120 },
    ]);

    expect(options).toEqual([
      expect.objectContaining({ tee: "white", courseRating: 35.4, slope: 124, totalYards: 3120 }),
    ]);
  });

  it("sorts longest first", () => {
    // A golfer picking a tee is choosing a length, so the list reads as one.
    const options = teeOptions(fullCourse);

    expect(options.map((o) => o.tee)).toEqual(["black", "blue", "white", "red"]);
    expect(options[0].totalYards).toBeGreaterThan(options[1].totalYards);
  });

  it("attaches rating and slope to the matching tee", () => {
    const options = teeOptions(fullCourse, [
      { tee: "blue", courseRating: 71.2, slope: 128, statedYardage: null },
    ]);

    expect(options.find((o) => o.tee === "blue")).toMatchObject({
      courseRating: 71.2,
      slope: 128,
    });
  });

  it("matches ratings case-insensitively", () => {
    const options = teeOptions(fullCourse, [
      { tee: "BLUE", courseRating: 70, slope: 120, statedYardage: null },
    ]);

    expect(options.find((o) => o.tee === "blue")?.slope).toBe(120);
  });

  it("prefers the course's stated total over the sum of its holes", () => {
    // Hole data is frequently partial: one real course has three of eighteen
    // measured, and summing those reported White as 617 yards.
    const sparse = [hole(1, { white: 350 })];
    const options = teeOptions(sparse, [
      { tee: "white", courseRating: null, slope: null, statedYardage: 6200 },
    ]);

    expect(options[0].totalYards).toBe(6200);
  });

  it("falls back to summing holes when no total is stated", () => {
    const options = teeOptions(fullCourse);

    expect(options.find((o) => o.tee === "white")?.totalYards).toBe(18 * 350);
  });

  it("sorts by the stated totals, not the partial sums", () => {
    // Blue is longer despite White having more measured holes.
    const sparse = [hole(1, { white: 350, blue: 100 })];
    const options = teeOptions(sparse, [
      { tee: "white", courseRating: null, slope: null, statedYardage: 6000 },
      { tee: "blue", courseRating: null, slope: null, statedYardage: 6600 },
    ]);

    expect(options.map((o) => o.tee)).toEqual(["blue", "white"]);
  });

  it("gives a display label", () => {
    expect(teeOptions(fullCourse)[0].label).toBe("Black");
  });

  it("returns nothing for a course with no yardages", () => {
    expect(teeOptions([hole(1, {})])).toEqual([]);
  });
});

describe("defaultTee", () => {
  const options = teeOptions(fullCourse);

  it("picks the longest when there is no preference", () => {
    expect(defaultTee(options)).toBe("black");
  });

  it("honours a saved preference", () => {
    expect(defaultTee(options, "white")).toBe("white");
  });

  it("matches a preference case-insensitively", () => {
    expect(defaultTee(options, "WHITE")).toBe("white");
  });

  it("falls back to the longest when the course lacks the preferred tee", () => {
    // A saved preference for a tee this course doesn't offer must not leave
    // the card blank.
    expect(defaultTee(options, "purple")).toBe("black");
  });

  it("returns null when there are no options", () => {
    expect(defaultTee([], "white")).toBeNull();
  });
});

describe("teeLabel", () => {
  it("title-cases the colour", () => {
    expect(teeLabel("white")).toBe("White");
  });

  it("leaves an already-capitalised name alone", () => {
    expect(teeLabel("Championship")).toBe("Championship");
  });
});
