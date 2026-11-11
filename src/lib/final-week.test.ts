import { describe, expect, it } from "vitest";

import { finalWarnings, localToday, openCards, unfinishedCards } from "./final-week";

describe("finalWarnings", () => {
  const base = { playedOn: "2026-11-04", status: "live" as const, holeCount: 9, open: [], today: "2026-11-04" };

  it("has nothing to say about a finished week played today", () => {
    expect(finalWarnings(base)).toEqual([]);
  });

  it("warns about a date still to come", () => {
    expect(finalWarnings({ ...base, playedOn: "2026-11-08" })).toEqual([
      "It's dated 2026-11-08, which hasn't come yet.",
    ]);
  });

  it("warns about a week still being set up", () => {
    expect(finalWarnings({ ...base, status: "setup" })[0]).toMatch(/still being set up/);
  });

  it("names the cards still open, and says they won't earn points", () => {
    const [warning] = finalWarnings({
      ...base,
      open: [
        { name: "Greg Golfer", posted: 4 },
        { name: "Mo Mulligan", posted: 0 },
      ],
    });
    expect(warning).toBe(
      "2 cards aren't finished: Greg Golfer (5 holes left), Mo Mulligan (not started). They won't earn points.",
    );
  });
});

describe("unfinishedCards", () => {
  it("says one hole left in the singular", () => {
    expect(unfinishedCards([{ name: "Lou Longhitter", posted: 8 }], 9)).toBe(
      "One card isn't finished: Lou Longhitter (1 hole left)",
    );
  });
});

describe("openCards", () => {
  it("is the players short of the week's holes, started or not", () => {
    expect(
      openCards(
        {
          holeCount: 9,
          players: [
            { name: "Lou", posted: 9 },
            { name: "Mo", posted: 5 },
            { name: "Sal", posted: 0 },
          ],
        },
        18,
      ).map((p) => p.name),
    ).toEqual(["Mo", "Sal"]);
  });
});

describe("localToday", () => {
  it("is the local date, not the UTC one", () => {
    expect(localToday(new Date(2026, 10, 4, 23, 30))).toBe("2026-11-04");
  });
});
