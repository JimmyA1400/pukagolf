import { describe, expect, it } from "vitest";

import { friendlyDate, nextLeagueDate, nextWeekDate, nextWeekName, weekdayPlural } from "./league-week";

describe("nextWeekName", () => {
  it("counts up from the number on the end", () => {
    expect(nextWeekName("Saturday Round 1")).toBe("Saturday Round 2");
    expect(nextWeekName("Week 9")).toBe("Week 10");
    expect(nextWeekName("Round 12")).toBe("Round 13");
  });

  it("starts a series from a name with no number", () => {
    expect(nextWeekName("Moose Open")).toBe("Moose Open 2");
  });

  it("ignores stray spaces", () => {
    expect(nextWeekName("  Saturday Round 4  ")).toBe("Saturday Round 5");
  });

  it("has something to offer for an empty name", () => {
    expect(nextWeekName("")).toBe("Week 1");
  });
});

describe("nextWeekDate", () => {
  it("is seven days on", () => {
    expect(nextWeekDate("2026-09-10")).toBe("2026-09-17");
  });

  it("rolls over a month and a year", () => {
    expect(nextWeekDate("2026-09-28")).toBe("2026-10-05");
    expect(nextWeekDate("2026-12-29")).toBe("2027-01-05");
  });

  it("is not thrown off by the clocks changing", () => {
    // US daylight saving ends on 2026-11-01.
    expect(nextWeekDate("2026-10-29")).toBe("2026-11-05");
  });
});

describe("nextLeagueDate: the league's usual day", () => {
  it("is a week on when every week is on the same day", () => {
    // Thursdays.
    expect(nextLeagueDate("2026-11-05", ["2026-10-22", "2026-10-29"])).toBe("2026-11-12");
  });

  it("goes back to the usual day after one week dated a day out", () => {
    // A Thursday league whose last week was put on Friday the 13th.
    expect(nextLeagueDate("2026-11-13", ["2026-10-29", "2026-11-05"])).toBe("2026-11-19");
  });

  it("keeps a league's own day, whatever it is", () => {
    // Saturdays, on purpose.
    expect(nextLeagueDate("2026-11-14", ["2026-11-07", "2026-10-31"])).toBe("2026-11-21");
  });

  it("follows the latest week when there's nothing else to go on, or a tie", () => {
    expect(nextLeagueDate("2026-11-13")).toBe("2026-11-20");
    expect(nextLeagueDate("2026-11-13", ["2026-11-05"])).toBe("2026-11-20");
  });
});

describe("round-7: dates and the league's day in words", () => {
  const today = new Date(2026, 10, 7);

  it("says a date the way a golfer would", () => {
    expect(friendlyDate("2026-11-19", today)).toBe("Thu, Nov 19");
  });

  it("adds the year when it isn't this one", () => {
    expect(friendlyDate("2025-08-02", today)).toBe("Sat, Aug 2, 2025");
  });

  it("names the league's day", () => {
    expect(weekdayPlural(4)).toBe("Thursdays");
    expect(weekdayPlural(0)).toBe("Sundays");
  });
});
