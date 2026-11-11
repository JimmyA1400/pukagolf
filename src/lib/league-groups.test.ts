import { describe, expect, it } from "vitest";

import { bySeatingOrder, groupSizes, planGroups } from "./league-groups";

describe("groupSizes", () => {
  it("fills foursomes when the numbers work", () => {
    expect(groupSizes(8)).toEqual([4, 4]);
    expect(groupSizes(12)).toEqual([4, 4, 4]);
  });

  it("spreads a remainder instead of leaving a straggler", () => {
    expect(groupSizes(5)).toEqual([3, 2]);
    expect(groupSizes(9)).toEqual([3, 3, 3]);
    expect(groupSizes(11)).toEqual([4, 4, 3]);
    expect(groupSizes(13)).toEqual([4, 3, 3, 3]);
  });

  it("never makes a group of one", () => {
    for (let n = 2; n <= 40; n++) {
      for (const capacity of [2, 3, 4]) {
        expect(Math.min(...groupSizes(n, capacity))).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("seats everybody", () => {
    for (let n = 2; n <= 40; n++) {
      expect(groupSizes(n).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it("stays within a foursome", () => {
    for (let n = 2; n <= 40; n++) {
      expect(Math.max(...groupSizes(n))).toBeLessThanOrEqual(4);
    }
  });

  it("makes a threesome rather than a pair and a single", () => {
    // The one case a capacity can't hold: 3 players in groups of 2.
    expect(groupSizes(3, 2)).toEqual([3]);
  });

  it("makes no groups for fewer than two players", () => {
    expect(groupSizes(0)).toEqual([]);
    expect(groupSizes(1)).toEqual([]);
  });
});

describe("planGroups", () => {
  it("keeps the seating order", () => {
    expect(planGroups(["a", "b", "c", "d", "e"])).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });
});

describe("bySeatingOrder", () => {
  const p = (name: string, preferredTeeTime: string | null) => ({
    name,
    preferredTeeTime,
  });

  it("seats the earliest requested tee time first, then the rest by name", () => {
    const sorted = [
      p("Zed", null),
      p("Amy", "09:00:00"),
      p("Bob", "08:10:00"),
      p("Cal", null),
    ].sort(bySeatingOrder);

    expect(sorted.map((x) => x.name)).toEqual(["Bob", "Amy", "Cal", "Zed"]);
  });
});
