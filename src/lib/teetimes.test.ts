import { describe, expect, it } from "vitest";

import {
  clockLabel,
  parseClock,
  planTeeTimes,
  teamsPerTeeTime,
  TEE_TIME_CAPACITY,
  type TeamRef,
} from "./teetimes";

/** n teams of `size`, keyed t1..tn. */
const teams = (n: number, size: number): TeamRef[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `t${i + 1}`,
    memberIds: Array.from({ length: size }, (_, j) => `t${i + 1}p${j + 1}`),
  }));

describe("teamsPerTeeTime", () => {
  it("puts four singles out together", () => {
    expect(teamsPerTeeTime("solo")).toBe(4);
  });

  it("puts two pairs out together", () => {
    expect(teamsPerTeeTime("scramble_2")).toBe(2);
    expect(teamsPerTeeTime("best_ball_2")).toBe(2);
  });

  it("puts one four-man team out alone", () => {
    expect(teamsPerTeeTime("scramble_4")).toBe(1);
    expect(teamsPerTeeTime("best_ball_4")).toBe(1);
  });

  it("puts one three-man team out alone rather than splitting one", () => {
    // Three does not divide four; the only way to reach four would be to break
    // a team apart, which is worse than going off as a threesome.
    expect(teamsPerTeeTime("scramble_3")).toBe(1);
  });
});

describe("planTeeTimes", () => {
  it("fills each tee time with four singles", () => {
    const { teeTimes, warning } = planTeeTimes("solo", teams(8, 1));

    expect(teeTimes).toHaveLength(2);
    expect(teeTimes[0].playerCount).toBe(TEE_TIME_CAPACITY);
    expect(teeTimes[0].teamKeys).toEqual(["t1", "t2", "t3", "t4"]);
    expect(warning).toBeNull();
  });

  it("sends two pairs off together", () => {
    const { teeTimes } = planTeeTimes("best_ball_2", teams(4, 2));

    expect(teeTimes).toHaveLength(2);
    expect(teeTimes[0].teamKeys).toEqual(["t1", "t2"]);
    expect(teeTimes[0].playerCount).toBe(4);
  });

  it("sends a four-man team off on its own", () => {
    const { teeTimes } = planTeeTimes("scramble_4", teams(3, 4));

    expect(teeTimes).toHaveLength(3);
    expect(teeTimes.every((t) => t.playerCount === 4)).toBe(true);
  });

  it("never splits a team across two tee times", () => {
    const { teeTimes } = planTeeTimes("scramble_2", teams(5, 2));
    const placements = teeTimes.flatMap((t) => t.teamKeys);

    expect(placements).toHaveLength(5);
    expect(new Set(placements).size).toBe(5);
  });

  it("spaces tee times ten minutes apart by default", () => {
    const { teeTimes } = planTeeTimes("scramble_4", teams(3, 4));

    expect(teeTimes.map((t) => t.time)).toEqual(["8:10a", "8:20a", "8:30a"]);
  });

  it("honours a custom start and interval", () => {
    const { teeTimes } = planTeeTimes("scramble_4", teams(2, 4), 13 * 60, 8);

    expect(teeTimes.map((t) => t.time)).toEqual(["1:00p", "1:08p"]);
  });

  it("warns when a tee time is short of four", () => {
    // Five pairs: two full tee times, then a lone pair.
    const { teeTimes, warning } = planTeeTimes("best_ball_2", teams(5, 2));

    expect(teeTimes).toHaveLength(3);
    expect(teeTimes[2].playerCount).toBe(2);
    expect(warning).toMatch(/1 tee time has fewer than 4/);
  });

  it("stays quiet for three-man play, where three is the intended size", () => {
    // Every tee time is a threesome by design, so warning about it every time
    // would be noise rather than information.
    expect(planTeeTimes("scramble_3", teams(4, 3)).warning).toBeNull();
  });

  it("returns nothing for an empty draw", () => {
    expect(planTeeTimes("scramble_4", []).teeTimes).toEqual([]);
  });
});

describe("clockLabel", () => {
  it.each([
    [8 * 60 + 10, "8:10a"],
    [12 * 60, "12:00p"],
    [13 * 60 + 5, "1:05p"],
    [0, "12:00a"],
    [23 * 60 + 59, "11:59p"],
  ])("renders %i as %s", (minutes, expected) => {
    expect(clockLabel(minutes)).toBe(expected);
  });

  it("wraps past midnight rather than producing a 25th hour", () => {
    expect(clockLabel(24 * 60 + 30)).toBe("12:30a");
  });
});

describe("parseClock", () => {
  it.each([
    ["8:10a", 8 * 60 + 10],
    ["8:10am", 8 * 60 + 10],
    ["1:05p", 13 * 60 + 5],
    ["12:00a", 0],
    ["12:30p", 12 * 60 + 30],
    ["14:20", 14 * 60 + 20],
  ])("reads %s", (label, expected) => {
    expect(parseClock(label)).toBe(expected);
  });

  it("round-trips with clockLabel", () => {
    for (const minutes of [0, 490, 720, 785, 1439]) {
      expect(parseClock(clockLabel(minutes))).toBe(minutes);
    }
  });

  it("rejects nonsense rather than guessing", () => {
    for (const bad of ["", "quarter past", "25:00", "8:99", "8"]) {
      expect(parseClock(bad)).toBeNull();
    }
  });
});
