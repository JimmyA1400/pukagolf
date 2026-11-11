import { describe, expect, it } from "vitest";

import {
  buildTeamStandings,
  FORMATS,
  getFormat,
  isFormatId,
  isTeamFormat,
  teamHoles,
  teamSize,
  validateTeams,
  type Entry,
} from "./legacy";

const PARS = Object.fromEntries(
  Array.from({ length: 18 }, (_, i) => [i + 1, 4]),
);

/** One player's score on one hole. */
const e = (
  teamId: string,
  playerId: string | null,
  hole: number,
  strokes: number,
): Entry => ({ teamId, playerId, hole, strokes });

describe("format catalogue", () => {
  it("offers the seven formats", () => {
    expect(FORMATS).toHaveLength(7);
  });

  it("derives team size from the format, never from the caller", () => {
    expect(teamSize("solo")).toBe(1);
    expect(teamSize("scramble_2")).toBe(2);
    expect(teamSize("best_ball_3")).toBe(3);
    expect(teamSize("scramble_4")).toBe(4);
  });

  it("knows which formats are team play", () => {
    expect(isTeamFormat("solo")).toBe(false);
    expect(isTeamFormat("best_ball_2")).toBe(true);
  });

  it("collects one score per team in a scramble and one per player otherwise", () => {
    expect(getFormat("scramble_4").entry).toBe("team");
    expect(getFormat("best_ball_4").entry).toBe("player");
    expect(getFormat("solo").entry).toBe("player");
  });

  it("recognises valid ids and rejects anything else", () => {
    expect(isFormatId("best_ball_2")).toBe(true);
    expect(isFormatId("shamble")).toBe(false);
  });

  it("throws on an unknown id rather than guessing", () => {
    expect(() => getFormat("nonsense" as never)).toThrow(/unknown format/i);
  });
});

describe("teamHoles — scramble", () => {
  it("takes the single score the team posts", () => {
    const holes = teamHoles(
      "scramble_2",
      [e("t1", null, 1, 4), e("t1", null, 2, 5)],
      "t1",
      ["a", "b"],
      3,
    );

    expect(holes.map((h) => h.strokes)).toEqual([4, 5, null]);
  });

  it("does not wait on individual cards", () => {
    // A scramble team plays one ball; two members but one score is complete.
    const [hole] = teamHoles("scramble_4", [e("t1", null, 1, 3)], "t1",
      ["a", "b", "c", "d"], 1);

    expect(hole.strokes).toBe(3);
  });

  it("has no contributors, since there is only one ball", () => {
    const [hole] = teamHoles("scramble_2", [e("t1", null, 1, 4)], "t1",
      ["a", "b"], 1);

    expect(hole.contributors).toEqual([]);
  });
});

describe("teamHoles — best ball", () => {
  const members = ["a", "b"];

  it("takes the lowest individual score once everyone has posted", () => {
    const [hole] = teamHoles(
      "best_ball_2",
      [e("t1", "a", 1, 5), e("t1", "b", 1, 4)],
      "t1",
      members,
      1,
    );

    expect(hole.strokes).toBe(4);
    expect(hole.contributors).toEqual(["b"]);
  });

  it("leaves the hole incomplete until every card is in", () => {
    // Counting the low of whoever finished first would show the team at 4 and
    // then move them backwards when the other player posts a 6.
    const [hole] = teamHoles("best_ball_2", [e("t1", "a", 1, 4)], "t1",
      members, 1);

    expect(hole.strokes).toBeNull();
    expect(hole.posted).toBe(1);
  });

  it("names both players when the low is tied", () => {
    const [hole] = teamHoles(
      "best_ball_2",
      [e("t1", "a", 1, 4), e("t1", "b", 1, 4)],
      "t1",
      members,
      1,
    );

    expect(hole.contributors).toEqual(["a", "b"]);
  });

  it("ignores a score from someone not on the team", () => {
    const [hole] = teamHoles(
      "best_ball_2",
      [e("t1", "a", 1, 5), e("t1", "b", 1, 5), e("t1", "stranger", 1, 2)],
      "t1",
      members,
      1,
    );

    expect(hole.strokes).toBe(5);
  });

  it("ignores entries belonging to another team", () => {
    const holes = teamHoles(
      "best_ball_2",
      [e("t2", "c", 1, 2), e("t2", "d", 1, 2)],
      "t1",
      members,
      1,
    );

    expect(holes[0].strokes).toBeNull();
  });
});

describe("buildTeamStandings", () => {
  const teams = [
    { id: "t1", memberIds: ["a", "b"] },
    { id: "t2", memberIds: ["c", "d"] },
  ];

  it("ranks the lower team score first", () => {
    const entries = [
      e("t1", "a", 1, 4), e("t1", "b", 1, 5), // team 4, level
      e("t2", "c", 1, 5), e("t2", "d", 1, 6), // team 5, +1
    ];
    const standings = buildTeamStandings("best_ball_2", entries, teams, 18, PARS);

    expect(standings.map((s) => s.teamId)).toEqual(["t1", "t2"]);
    expect(standings[0].toPar).toBe(0);
    expect(standings[1].toPar).toBe(1);
  });

  it("counts only completed holes in thru", () => {
    // Hole 2 has one card of two, so it is not counted at all.
    const entries = [
      e("t1", "a", 1, 4), e("t1", "b", 1, 4),
      e("t1", "a", 2, 3),
    ];
    const [standing] = buildTeamStandings("best_ball_2", entries,
      [teams[0]], 18, PARS);

    expect(standing.thru).toBe(1);
    expect(standing.strokes).toBe(4);
  });

  it("compares fairly across teams that are mid-round", () => {
    // t1 is level thru 2; t2 is +2 thru 4. Level leads despite fewer strokes.
    const entries = [
      e("t1", "a", 1, 4), e("t1", "b", 1, 4),
      e("t1", "a", 2, 4), e("t1", "b", 2, 4),
      ...[1, 2, 3, 4].flatMap((h) => [
        e("t2", "c", h, 5),
        e("t2", "d", h, 4 + (h <= 2 ? 1 : 0)),
      ]),
    ];
    const standings = buildTeamStandings("best_ball_2", entries, teams, 18, PARS);

    expect(standings[0].teamId).toBe("t1");
  });

  it("ranks a team that has not teed off last", () => {
    const entries = [e("t1", "a", 1, 4), e("t1", "b", 1, 4)];
    const standings = buildTeamStandings("best_ball_2", entries, teams, 18, PARS);

    expect(standings.map((s) => s.teamId)).toEqual(["t1", "t2"]);
    expect(standings[1].thru).toBe(0);
  });

  it("gives tied teams the same position", () => {
    const entries = [
      e("t1", "a", 1, 4), e("t1", "b", 1, 4),
      e("t2", "c", 1, 4), e("t2", "d", 1, 4),
    ];
    const standings = buildTeamStandings("best_ball_2", entries, teams, 18, PARS);

    expect(standings.map((s) => s.position)).toEqual([1, 1]);
  });

  it("falls back to raw strokes without par data", () => {
    const entries = [
      e("t1", "a", 1, 4), e("t1", "b", 1, 4),
      e("t2", "c", 1, 3), e("t2", "d", 1, 3),
    ];
    const standings = buildTeamStandings("best_ball_2", entries, teams, 18);

    expect(standings[0].teamId).toBe("t2");
    expect(standings[0].toPar).toBeNull();
  });

  it("treats each solo player as their own team", () => {
    const solo = [
      { id: "a", memberIds: ["a"] },
      { id: "b", memberIds: ["b"] },
    ];
    const entries = [e("a", "a", 1, 5), e("b", "b", 1, 3)];
    const standings = buildTeamStandings("solo", entries, solo, 18, PARS);

    expect(standings[0].teamId).toBe("b");
  });
});

describe("validateTeams", () => {
  it("accepts teams of exactly the format's size", () => {
    expect(
      validateTeams("scramble_2", [
        { memberIds: ["a", "b"] },
        { memberIds: ["c", "d"] },
      ]).ok,
    ).toBe(true);
  });

  it("rejects a team that is short", () => {
    const result = validateTeams("scramble_4", [{ memberIds: ["a", "b"] }]);

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/teams of 4/);
  });

  it("rejects a team that is oversized", () => {
    expect(
      validateTeams("best_ball_2", [{ memberIds: ["a", "b", "c"] }]).ok,
    ).toBe(false);
  });

  it("rejects a player appearing on two teams", () => {
    const result = validateTeams("scramble_2", [
      { memberIds: ["a", "b"] },
      { memberIds: ["a", "c"] },
    ]);

    expect((result as { reason: string }).reason).toMatch(/more than one team/);
  });

  it("requires exactly one player per team in solo", () => {
    expect(validateTeams("solo", [{ memberIds: ["a"] }]).ok).toBe(true);
    expect(validateTeams("solo", [{ memberIds: ["a", "b"] }]).ok).toBe(false);
  });
});
