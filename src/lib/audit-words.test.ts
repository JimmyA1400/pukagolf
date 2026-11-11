import { describe, expect, it } from "vitest";

import { describeAuditEntry, foldRepeats, type ClubAuditEntry } from "./audit-words";

const entry = (over: Partial<ClubAuditEntry>): ClubAuditEntry => ({
  id: 1,
  at: "2026-11-04T22:00:00Z",
  actor: "Hank Headpro",
  action: "update",
  entity: "score",
  entityId: "x",
  detail: null,
  player: "Mo Mulligan",
  week: "Week 1 · Practice Ridge Sunday",
  ...over,
});

describe("describeAuditEntry", () => {
  it("says a score change with its reason", () => {
    expect(
      describeAuditEntry(entry({ detail: { hole: 1, from: 6, to: 5, reason: "card said 5" } })),
    ).toBe("changed Mo Mulligan’s hole 1 from 6 to 5. Reason: “card said 5”");
  });

  it("says who was let into the club", () => {
    expect(describeAuditEntry(entry({ entity: "club_member", action: "approve" }))).toBe(
      "let Mo Mulligan into the club",
    );
  });

  it("says when a week is set Live", () => {
    expect(
      describeAuditEntry(entry({ entity: "round", action: "update", detail: { status: "live" }, player: null })),
    ).toBe("set the week to live");
  });

  it("falls back to the raw words for anything new", () => {
    expect(describeAuditEntry(entry({ entity: "widget", action: "spin" }))).toBe("spin widget");
  });
});

describe("round-4 wording", () => {
  it("says a cleared handicap was cleared", () => {
    expect(
      describeAuditEntry(entry({ entity: "handicap", detail: { handicap_index: null } })),
    ).toBe("cleared Mo Mulligan’s handicap index");
  });

  it("names the league of a rules or season line", () => {
    expect(describeAuditEntry(entry({ entity: "league_rules", league: "Practice Ridge Sunday" }))).toBe(
      "changed Practice Ridge Sunday’s rules",
    );
    expect(
      describeAuditEntry(entry({ entity: "season", action: "close", entityId: "2026", league: "Sunday" })),
    ).toBe("closed the 2026 season of Sunday");
  });

  it("names the group a player was moved to", () => {
    expect(
      describeAuditEntry(entry({ entity: "pairing", detail: { to: "t2" }, toGroup: "Group 2" })),
    ).toBe("moved Mo Mulligan to Group 2");
  });

  it("shows one Save rules once", () => {
    const save = (id: number, at: string) =>
      entry({ id, at, entity: "league_rules", action: "update", league: "Sunday" });
    expect(
      foldRepeats([
        save(3, "2026-11-06T20:00:02Z"),
        save(2, "2026-11-06T20:00:01Z"),
        save(1, "2026-11-06T20:00:00Z"),
      ]),
    ).toHaveLength(1);
  });
});

describe("round-5 wording", () => {
  it("says a sign-off was taken back, not that a card was unlocked", () => {
    expect(
      describeAuditEntry(entry({ entity: "card", action: "take_back", entityId: "tee-1", detail: { cards: 2 } })),
    ).toBe("took back the sign-off on Mo Mulligan’s group (2 cards)");
    expect(
      describeAuditEntry(entry({ entity: "card", action: "take_back", entityId: "round-1:player-1" })),
    ).toBe("took back the sign-off on Mo Mulligan’s card");
  });

  it("names the Can fix scores setting", () => {
    expect(
      describeAuditEntry(
        entry({ entity: "club_member", action: "update", detail: { staff_can_edit_scores: true } }),
      ),
    ).toBe("turned on “Can fix scores” for Mo Mulligan");
    expect(
      describeAuditEntry(
        entry({ entity: "club_member", action: "update", detail: { staff_can_edit_scores: false } }),
      ),
    ).toBe("turned off “Can fix scores” for Mo Mulligan");
  });

  it("says a week went final, and with whose cards unfinished", () => {
    expect(
      describeAuditEntry(
        entry({
          entity: "round",
          action: "final",
          detail: { unfinished: 2, short: ["Mo Mulligan (5 of 9)", "Sal Sandtrap (0 of 9)"] },
        }),
      ),
    ).toBe("marked the week final with 2 cards unfinished: Mo Mulligan (5 of 9), Sal Sandtrap (0 of 9)");
    expect(describeAuditEntry(entry({ entity: "round", action: "final", detail: { short: [] } }))).toBe(
      "marked the week final, every card finished",
    );
  });

  it("says clearing a week took back its sign-offs", () => {
    expect(
      describeAuditEntry(entry({ entity: "round", action: "clear_scores", detail: { cards_reopened: 2 } })),
    ).toBe("cleared the week’s scores and took back 2 cards’ sign-off or lock");
  });
});

describe("round-6 wording", () => {
  const rules = (detail: Record<string, unknown>) =>
    entry({ entity: "league_rules", league: "Hank Run Four", detail, player: null });

  it("names a scoring mode change, from and to", () => {
    expect(describeAuditEntry(rules({ scoring_mode: "team", from: "partner" }))).toBe(
      "switched Hank Run Four from Partner Scoring to Team Card Scoring",
    );
    // Before 0058 every save logged the mode, changed or not.
    expect(describeAuditEntry(rules({ scoring_mode: "self" }))).toBe("saved Hank Run Four’s rules, on Self Scoring");
  });

  it("names the double-par switch", () => {
    expect(describeAuditEntry(rules({ double_par_cap: false }))).toBe(
      "turned off “Pick up at double par” for Hank Run Four",
    );
  });

  it("says a final week's sign-off was taken back, with its reason", () => {
    expect(
      describeAuditEntry(
        entry({
          entity: "card",
          action: "take_back",
          entityId: "tee-1",
          player: "Hank Headpro",
          detail: { cards: 1, week_final: true, reason: "signed by mistake, no scores" },
        }),
      ),
    ).toBe(
      "took back the sign-off on Hank Headpro’s group (1 card) in a final week. Reason: “signed by mistake, no scores”",
    );
  });

  it("shows the Final control once, not as two lines", () => {
    const round = { entity: "round", entityId: "w3", player: null };
    const folded = foldRepeats([
      entry({ ...round, id: 2, action: "final", at: "2026-11-07T01:00:01Z", detail: { short: ["Lou (4 of 9)"] } }),
      entry({ ...round, id: 1, action: "update", at: "2026-11-07T01:00:00Z", detail: { status: "final" } }),
    ]);
    expect(folded.map(describeAuditEntry)).toEqual(["marked the week final with 1 card unfinished: Lou (4 of 9)"]);
  });

  it("keeps a status change that isn't the week going final", () => {
    const round = { entity: "round", entityId: "w3", player: null };
    expect(
      foldRepeats([entry({ ...round, id: 1, action: "update", detail: { status: "live" } })]),
    ).toHaveLength(1);
  });
});
