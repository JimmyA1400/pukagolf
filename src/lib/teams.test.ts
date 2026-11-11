import { describe, expect, it } from "vitest";

import {
  autoAssignTeams,
  movePlayer,
  shuffle,
  swapPlayers,
  unassigned,
  type DraftTeam,
} from "./teams";

const roster = (n: number) =>
  Array.from({ length: n }, (_, i) => `p${i + 1}`);

const members = (teams: DraftTeam[]) => teams.map((t) => t.memberIds);

describe("autoAssignTeams", () => {
  it("splits an even roster into full teams", () => {
    const { teams, warning } = autoAssignTeams("scramble_4", roster(8));

    expect(members(teams)).toEqual([
      ["p1", "p2", "p3", "p4"],
      ["p5", "p6", "p7", "p8"],
    ]);
    expect(warning).toBeNull();
  });

  it("makes pairs for a 2-man format", () => {
    expect(members(autoAssignTeams("best_ball_2", roster(6)).teams)).toEqual([
      ["p1", "p2"],
      ["p3", "p4"],
      ["p5", "p6"],
    ]);
  });

  it("gives each player their own team in solo", () => {
    const { teams } = autoAssignTeams("solo", roster(3));

    expect(members(teams)).toEqual([["p1"], ["p2"], ["p3"]]);
    expect(teams).toHaveLength(3);
  });

  it("warns about a short team rather than hiding it", () => {
    // 22 players in fours is the classic outing case: five fours and a pair.
    const { teams, shortTeamKeys, warning } = autoAssignTeams(
      "scramble_4",
      roster(22),
    );

    expect(teams).toHaveLength(6);
    expect(teams[5].memberIds).toEqual(["p21", "p22"]);
    expect(shortTeamKeys).toEqual(["t6"]);
    expect(warning).toMatch(/don't divide into teams of 4/);
  });

  it("counts the remainder correctly in the warning", () => {
    expect(autoAssignTeams("scramble_3", roster(7)).warning).toMatch(
      /One player is/,
    );
    expect(autoAssignTeams("scramble_4", roster(6)).warning).toMatch(
      /2 players are/,
    );
  });

  it("says how many more are needed to fill the short team", () => {
    expect(autoAssignTeams("scramble_4", roster(9)).warning).toMatch(/add 3 more/);
  });

  it("names teams in order", () => {
    const { teams } = autoAssignTeams("scramble_2", roster(4));

    expect(teams.map((t) => t.name)).toEqual(["Team 1", "Team 2"]);
  });

  it("handles an empty roster without inventing a team", () => {
    expect(autoAssignTeams("scramble_4", []).teams).toEqual([]);
  });

  it("places every player exactly once", () => {
    const ids = roster(23);
    const { teams } = autoAssignTeams("best_ball_3", ids);
    const placed = teams.flatMap((t) => t.memberIds);

    expect(placed).toHaveLength(23);
    expect(new Set(placed).size).toBe(23);
  });
});

describe("shuffle", () => {
  it("is reproducible from its seed", () => {
    expect(shuffle(roster(10), 42)).toEqual(shuffle(roster(10), 42));
  });

  it("gives a different draw for a different seed", () => {
    expect(shuffle(roster(10), 1)).not.toEqual(shuffle(roster(10), 2));
  });

  it("keeps every player", () => {
    const ids = roster(12);

    expect([...shuffle(ids, 7)].sort()).toEqual([...ids].sort());
  });

  it("does not mutate the input", () => {
    const ids = roster(5);
    shuffle(ids, 3);

    expect(ids).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("survives a zero seed", () => {
    expect(shuffle(roster(4), 0)).toHaveLength(4);
  });
});

describe("movePlayer", () => {
  const teams: DraftTeam[] = [
    { key: "t1", name: "Team 1", memberIds: ["a", "b"] },
    { key: "t2", name: "Team 2", memberIds: ["c", "d"] },
  ];

  it("moves a player and removes them from the old team", () => {
    const after = movePlayer(teams, "a", "t2");

    expect(members(after)).toEqual([["b"], ["c", "d", "a"]]);
  });

  it("does not duplicate when moving within the same team", () => {
    const after = movePlayer(teams, "a", "t1");

    expect(after[0].memberIds).toEqual(["b", "a"]);
    expect(after[0].memberIds).toHaveLength(2);
  });

  it("places a player who was on no team", () => {
    // This is how an unassigned player gets picked up, so adding them is
    // correct rather than a miss.
    expect(members(movePlayer(teams, "e", "t1"))).toEqual([
      ["a", "b", "e"],
      ["c", "d"],
    ]);
  });

  it("leaves other teams untouched when placing someone", () => {
    expect(movePlayer(teams, "e", "t1")[1].memberIds).toEqual(["c", "d"]);
  });
});

describe("swapPlayers", () => {
  const teams: DraftTeam[] = [
    { key: "t1", name: "Team 1", memberIds: ["a", "b"] },
    { key: "t2", name: "Team 2", memberIds: ["c", "d"] },
  ];

  it("exchanges two players between teams", () => {
    expect(members(swapPlayers(teams, "a", "c"))).toEqual([
      ["c", "b"],
      ["a", "d"],
    ]);
  });

  it("keeps team sizes unchanged", () => {
    const after = swapPlayers(teams, "b", "d");

    expect(after.map((t) => t.memberIds.length)).toEqual([2, 2]);
  });

  it("does nothing when both are on the same team", () => {
    expect(members(swapPlayers(teams, "a", "b"))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does nothing when a player is not on any team", () => {
    expect(members(swapPlayers(teams, "a", "zzz"))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("unassigned", () => {
  it("finds players on no team", () => {
    const teams: DraftTeam[] = [
      { key: "t1", name: "Team 1", memberIds: ["a", "b"] },
    ];

    expect(unassigned(teams, ["a", "b", "c"])).toEqual(["c"]);
  });

  it("returns nothing when everyone is placed", () => {
    const teams: DraftTeam[] = [
      { key: "t1", name: "Team 1", memberIds: ["a"] },
    ];

    expect(unassigned(teams, ["a"])).toEqual([]);
  });
});
