import { describe, expect, it } from "vitest";

import type { Score } from "./leaderboard";
import {
  applyScore,
  assignedTo,
  canScore,
  cardKeeper,
  keepsOwnCard,
  keptBy,
  seedAssignments,
  validateSubmission,
} from "./scoring-rules";

const GROUPS = [
  { playerIds: ["marcus", "priya", "jreyes"] },
  { playerIds: ["owen", "dana"] },
];

const ASSIGNMENTS = seedAssignments(GROUPS);

const attempt = (over: Partial<Parameters<typeof validateSubmission>[0]> = {}) =>
  validateSubmission({
    assignments: ASSIGNMENTS,
    scores: [],
    viewerId: "jreyes",
    targetId: "marcus",
    hole: 1,
    strokes: 4,
    isAdmin: false,
    ...over,
  });

describe("seedAssignments", () => {
  it("rotates within each group independently", () => {
    expect(ASSIGNMENTS).toEqual([
      { scorerId: "marcus", scoredId: "priya" },
      { scorerId: "priya", scoredId: "jreyes" },
      { scorerId: "jreyes", scoredId: "marcus" },
      { scorerId: "owen", scoredId: "dana" },
      { scorerId: "dana", scoredId: "owen" },
    ]);
  });

  it("skips a group too small to rotate rather than throwing", () => {
    expect(seedAssignments([{ playerIds: ["solo"] }])).toEqual([]);
  });

  it("finds who a player keeps and who keeps them", () => {
    expect(assignedTo(ASSIGNMENTS, "jreyes")).toBe("marcus");
    expect(keptBy(ASSIGNMENTS, "jreyes")).toBe("priya");
  });
});

describe("canScore", () => {
  it("allows the assigned scorer", () => {
    expect(canScore(ASSIGNMENTS, "jreyes", "marcus", false).ok).toBe(true);
  });

  it("refuses self-scoring", () => {
    const result = canScore(ASSIGNMENTS, "jreyes", "jreyes", false);

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/your own/i);
  });

  it("refuses a player they are not assigned to", () => {
    expect(canScore(ASSIGNMENTS, "jreyes", "priya", false).ok).toBe(false);
  });

  it("refuses someone in another group entirely", () => {
    expect(canScore(ASSIGNMENTS, "jreyes", "dana", false).ok).toBe(false);
  });

  it("lets the admin score anyone", () => {
    expect(canScore(ASSIGNMENTS, "admin", "dana", true).ok).toBe(true);
  });

  it("keeps an admin's own card the league's way", () => {
    expect(canScore(ASSIGNMENTS, "jreyes", "jreyes", true).ok).toBe(false);
    expect(canScore(ASSIGNMENTS, "jreyes", "jreyes", true, { mode: "self" }).ok).toBe(true);
  });

  it("says why Partner Scoring won't take your own card", () => {
    const result = canScore(ASSIGNMENTS, "jreyes", "jreyes", false);
    expect((result as { reason: string }).reason).toMatch(/someone else/);
  });
});

describe("a keeper with no login", () => {
  // priya keeps jreyes's card here, and has no login.
  const keeper = keptBy(ASSIGNMENTS, "jreyes")!;

  it("lets you keep your own card", () => {
    expect(keepsOwnCard(ASSIGNMENTS, "jreyes", [keeper])).toBe(true);
    expect(canScore(ASSIGNMENTS, "jreyes", "jreyes", false, { noLogin: [keeper] }).ok).toBe(true);
  });

  it("still lets you keep the card you were given", () => {
    const given = assignedTo(ASSIGNMENTS, "jreyes")!;
    expect(canScore(ASSIGNMENTS, "jreyes", given, false, { noLogin: [keeper] }).ok).toBe(true);
  });

  it("changes nothing for someone whose keeper can sign in", () => {
    expect(keepsOwnCard(ASSIGNMENTS, "owen", [keeper])).toBe(false);
    expect(canScore(ASSIGNMENTS, "owen", "owen", false, { noLogin: [keeper] }).ok).toBe(false);
  });
});

describe("validateSubmission", () => {
  const throughThree: Score[] = [1, 2, 3].map((hole) => ({
    playerId: "marcus",
    hole,
    strokes: 4,
  }));

  it("accepts the next hole in order", () => {
    expect(attempt({ scores: throughThree, hole: 4 }).ok).toBe(true);
  });

  it("refuses a hole that would leave a gap", () => {
    const result = attempt({ scores: throughThree, hole: 6 });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/before hole 6/);
  });

  it("allows correcting a hole already entered", () => {
    expect(attempt({ scores: throughThree, hole: 2, strokes: 7 }).ok).toBe(true);
  });

  it("lets the admin fill a gap", () => {
    expect(
      attempt({ scores: throughThree, hole: 9, isAdmin: true }).ok,
    ).toBe(true);
  });

  it("rejects a stroke count the database would refuse", () => {
    for (const strokes of [0, -1, 21, 4.5]) {
      expect(attempt({ strokes }).ok).toBe(false);
    }
  });

  it("checks permission before anything else", () => {
    const result = attempt({ targetId: "jreyes", strokes: 99 });

    expect((result as { reason: string }).reason).toMatch(/your own/i);
  });
});

describe("applyScore", () => {
  it("adds a new hole", () => {
    expect(applyScore([], "marcus", 1, 4)).toEqual([
      { playerId: "marcus", hole: 1, strokes: 4 },
    ]);
  });

  it("replaces an existing hole rather than duplicating it", () => {
    const before: Score[] = [{ playerId: "marcus", hole: 1, strokes: 4 }];
    const after = applyScore(before, "marcus", 1, 6);

    expect(after).toHaveLength(1);
    expect(after[0].strokes).toBe(6);
  });

  it("leaves other players untouched", () => {
    const before: Score[] = [
      { playerId: "marcus", hole: 1, strokes: 4 },
      { playerId: "priya", hole: 1, strokes: 5 },
    ];

    expect(applyScore(before, "marcus", 1, 3)).toHaveLength(2);
  });
});

describe("scoring modes", () => {
  const GROUP = GROUPS[0].playerIds;

  it("Self Scoring: your own card and nobody else's", () => {
    expect(canScore(ASSIGNMENTS, "jreyes", "jreyes", false, { mode: "self" }).ok).toBe(true);
    expect(canScore(ASSIGNMENTS, "jreyes", "marcus", false, { mode: "self" }).ok).toBe(false);
  });

  it("Team Card Scoring: any card in your group, none outside it", () => {
    const team = { mode: "team" as const, group: GROUP };
    expect(canScore(ASSIGNMENTS, "jreyes", "jreyes", false, team).ok).toBe(true);
    expect(canScore(ASSIGNMENTS, "jreyes", "priya", false, team).ok).toBe(true);
    expect(canScore(ASSIGNMENTS, "jreyes", "dana", false, team).ok).toBe(false);
  });

  it("Partner Scoring stays the default", () => {
    expect(canScore(ASSIGNMENTS, "jreyes", "jreyes", false, {}).ok).toBe(false);
  });
});

describe("signed-off cards", () => {
  it("refuses the scorer and staff who fix scores", () => {
    expect(attempt({ locked: true }).ok).toBe(false);
    expect(attempt({ locked: true, isAdmin: true, isClubAdmin: false }).ok).toBe(false);
  });

  it("lets a club admin change them", () => {
    expect(attempt({ locked: true, isAdmin: true }).ok).toBe(true);
  });

  it("but not the admin's own", () => {
    expect(attempt({ locked: true, isAdmin: true, targetId: "jreyes" }).ok).toBe(false);
  });
});

describe("cardKeeper: who keeps a card, for the pad and the Groups page", () => {
  const ring = [
    { scorerId: "hank", scoredId: "rita" },
    { scorerId: "rita", scoredId: "hank" },
  ];

  it("Partner Scoring: the partner, unless the partner has no login", () => {
    expect(cardKeeper("rita", { mode: "partner", assignments: ring })).toEqual({ kind: "player", id: "hank" });
    // Rita has no login: Hank keeps his own, and Rita's card is still Hank's.
    expect(cardKeeper("hank", { mode: "partner", assignments: ring, noLogin: ["rita"] })).toEqual({ kind: "self" });
    expect(cardKeeper("rita", { mode: "partner", assignments: ring, noLogin: ["rita"] })).toEqual({
      kind: "player",
      id: "hank",
    });
  });

  it("Self Scoring: the player, or the pro shop for one with no login", () => {
    expect(cardKeeper("hank", { mode: "self", assignments: ring, noLogin: ["rita"] })).toEqual({ kind: "self" });
    expect(cardKeeper("rita", { mode: "self", assignments: ring, noLogin: ["rita"] })).toEqual({ kind: "pro_shop" });
  });

  it("Team Card Scoring: anyone in the group, or the pro shop if nobody can sign in", () => {
    expect(cardKeeper("rita", { mode: "team", group: ["hank", "rita", "mo"], noLogin: ["rita"] })).toEqual({ kind: "group" });
    // Only Hank can sign in, so the card is his to keep, not "anyone's".
    expect(cardKeeper("rita", { mode: "team", group: ["hank", "rita"], noLogin: ["rita"] })).toEqual({
      kind: "player",
      id: "hank",
    });
    expect(cardKeeper("hank", { mode: "team", group: ["hank", "rita"], noLogin: ["rita"] })).toEqual({
      kind: "player",
      id: "hank",
    });
    expect(cardKeeper("rita", { mode: "team", group: ["rita"], noLogin: ["rita"] })).toEqual({ kind: "pro_shop" });
  });

  it("agrees with the pad's own rule for keeping your own card", () => {
    for (const noLogin of [[], ["rita"], ["hank"]]) {
      expect(cardKeeper("hank", { mode: "partner", assignments: ring, noLogin }).kind === "self").toBe(
        keepsOwnCard(ring, "hank", noLogin),
      );
    }
  });

  it("Partner Scoring with nobody given the card", () => {
    expect(cardKeeper("solo", { mode: "partner", assignments: ring })).toEqual({ kind: "nobody" });
  });
});
