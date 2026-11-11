import { describe, expect, it } from "vitest";

import { lockedWhen, lockReasons, lockSummary, lockWarning } from "./card-locks";

describe("lockReasons", () => {
  it("says what happened to the card itself first", () => {
    expect(
      lockReasons({ cardLock: { how: "signed", by: "greg" }, weekFinal: true, seasonClosed: true }),
    ).toEqual(["signed_off", "week_final", "season_closed"]);
  });

  it("tells an admin's lock from the group's sign-off", () => {
    expect(lockReasons({ cardLock: { how: "admin", by: "hank" } })).toEqual(["locked"]);
  });

  it("has nothing to say about an open card", () => {
    expect(lockReasons({})).toEqual([]);
  });
});

describe("what a locked card says", () => {
  it("never says a card was signed when the week was only marked final", () => {
    const warning = lockWarning(["week_final"], "Sal Sandtrap");

    expect(warning).toContain("Nobody signed Sal Sandtrap’s card.");
    expect(warning).toContain("The week is marked final");
    expect(warning).not.toMatch(/signed off|agreed/);
  });

  it("names who signed, when the group did", () => {
    expect(lockWarning(["signed_off"], "Pat Partner", "Greg G.")).toMatch(/signed off by Greg G\.: the group agreed/);
    expect(lockSummary(["signed_off", "week_final"], "Greg G.")).toBe(
      "Signed off by Greg G. · week marked final",
    );
  });

  it("says a closed season is settled", () => {
    expect(lockWarning(["season_closed"], "Rita Requester")).toContain("The season is closed");
    expect(lockSummary(["season_closed"])).toBe("Season closed");
  });
});

describe("lockedWhen, for the card's history", () => {
  it("says the week was final, not that the card was signed", () => {
    expect(lockedWhen("week_final")).toBe(" after the week was marked final");
  });

  it("lists every reason that applied", () => {
    expect(lockedWhen("week_final,season_closed")).toBe(
      " after the week was marked final and the season was closed",
    );
  });

  it("is silent for an ordinary change", () => {
    expect(lockedWhen(null)).toBe("");
  });
});
