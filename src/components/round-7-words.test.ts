import { describe, expect, it } from "vitest";

import { clearWarning } from "./LeagueAdmin";
import { describeChange, waitedOnPhone } from "./league/ScoreEntry";

/** The testers' seventh run: words in the card's history and the admin page. */

describe("the card's history", () => {
  it("gives the reason a final week's sign-off was taken back", () => {
    expect(
      describeChange({
        at: "2026-11-07T08:00:00Z",
        action: "take_back",
        entity: "card",
        by: "Hank Headpro",
        hole: null,
        strokes: null,
        from: null,
        to: null,
        reason: "Signed by mistake",
      }),
    ).toBe("Hank Headpro took back the group's sign-off. Reason: “Signed by mistake”");
  });

  it("marks only a hole that waited on the phone as offline", () => {
    // Entered and received in the same second: it went up at once.
    expect(waitedOnPhone({ at: "2026-11-07T07:41:01.400Z", phoneAt: "2026-11-07T07:41:01.000Z" })).toBe(false);
    expect(waitedOnPhone({ at: "2026-11-07T07:44:04Z", phoneAt: "2026-11-07T07:42:44Z" })).toBe(true);
    expect(waitedOnPhone({ at: "2026-11-07T07:44:04Z", phoneAt: null })).toBe(false);
  });
});

describe("clearing a final week", () => {
  const week = { name: "Week 2", status: "final" as const };

  it("says it goes back to Live when no other week is", () => {
    expect(clearWarning(week, 0)).toContain("clearing it sets it back to Live");
  });

  it("says it stays final while another week is Live, so there are never two", () => {
    const words = clearWarning(week, 0, "Week 3");
    expect(words).toContain("It stays final, as Week 3 is the Live week.");
    expect(words).not.toContain("back to Live");
  });
});
