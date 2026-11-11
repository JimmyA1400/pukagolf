import { describe, expect, it } from "vitest";

import { parsePointsTable } from "./league-rules";

describe("parsePointsTable", () => {
  it("reads commas, spaces or both", () => {
    expect(parsePointsTable("10, 8 6,5")).toEqual({ ok: true, value: [10, 8, 6, 5] });
  });

  it("allows equal points for neighbouring places", () => {
    expect(parsePointsTable("5 5 3")).toEqual({ ok: true, value: [5, 5, 3] });
  });

  it("refuses points that go up further down", () => {
    expect(parsePointsTable("10, 8, 9").ok).toBe(false);
  });

  it("refuses decimals, negatives and anything over 100", () => {
    expect(parsePointsTable("10, 7.5").ok).toBe(false);
    expect(parsePointsTable("10, -1").ok).toBe(false);
    expect(parsePointsTable("101").ok).toBe(false);
  });

  it("refuses an empty table and one longer than 12 places", () => {
    expect(parsePointsTable("  ").ok).toBe(false);
    expect(parsePointsTable("13 12 11 10 9 8 7 6 5 4 3 2 1").ok).toBe(false);
  });
});
