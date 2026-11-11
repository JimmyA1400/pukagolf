import { afterEach, describe, expect, it, vi } from "vitest";

import { enteredOnPhone, lockedInWords, plainError, refusalLine } from "./useLiveRound";

describe("lockedInWords: the lock refusal says locked once", () => {
  it("reads a sign-off as who signed it and when", () => {
    expect(
      lockedInWords("The card is locked: signed off by Greg Golfer, Nov 5, 6:12 PM. Only a club admin can change it now."),
    ).toBe("the card was signed off by Greg Golfer, Nov 5, 6:12 PM. Only a club admin can change it now.");
  });

  it("reads a final week as the week, not as a locked lock", () => {
    expect(
      lockedInWords("The card is locked: the week is marked final. Only a club admin can change it now."),
    ).toBe("the week is marked final. Only a club admin can change it now.");
  });
});

describe("plainError: no signal, or PukaGolf not answering", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says no signal when the phone has none", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(plainError({ message: "TypeError: Failed to fetch" }, "The cards weren't signed")).toBe(
      "The cards weren't signed: no signal. Try again when you have signal.",
    );
  });

  it("says PukaGolf can't be reached when there is signal and no answer", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(plainError({ message: "TypeError: Failed to fetch" }, "The cards weren't signed")).toBe(
      "The cards weren't signed: can't reach PukaGolf right now. Try again in a minute.",
    );
  });

  it("passes the database's own words through", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(plainError({ message: "Not every card is finished yet: Mo." }, "x")).toBe(
      "Not every card is finished yet: Mo.",
    );
  });
});

describe("enteredOnPhone: the time a waiting hole was really entered", () => {
  const item = { id: "1", playerId: "p", hole: 1, strokes: 4, enteredBy: "p" };

  it("is left out for a hole that went up at once", () => {
    expect(enteredOnPhone({ ...item, enteredAt: 1_000_000 }, 1_010_000)).toBeNull();
  });

  it("is sent for a hole that waited on the phone", () => {
    expect(enteredOnPhone({ ...item, enteredAt: Date.UTC(2026, 10, 6, 21, 40) }, Date.UTC(2026, 10, 6, 21, 47))).toBe(
      "2026-11-06T21:40:00.000Z",
    );
  });
});

describe("round-6: an offline correction says when it was entered", () => {
  const item = { id: "1", playerId: "p", hole: 1, strokes: 4, enteredBy: "p" };

  it("is sent for a hole entered with no signal, however soon it goes up", () => {
    expect(enteredOnPhone({ ...item, enteredAt: 1_000_000, offline: true }, 1_005_000)).toBe(
      new Date(1_000_000).toISOString(),
    );
  });
});

describe("round-6: an admin's own locked card", () => {
  const signed = {
    code: "P0001",
    hint: "card_locked",
    message: "The card is locked: signed off by Rita Requester, Nov 7, 1:10 AM. Only a club admin can change it now.",
  };
  const item = { id: "1", playerId: "hank", hole: 3, strokes: 5, enteredBy: "hank" };

  it("doesn't tell a club admin to ask a club admin", () => {
    const line = refusalLine(null, item, signed, true);
    expect(line).not.toMatch(/Only a club admin/);
    expect(line).toMatch(/your own card: take back the group's sign-off in "Fix any card"/);
  });

  it("still tells a player who to ask", () => {
    expect(refusalLine(null, item, signed, false)).toMatch(/Only a club admin can change it now/);
  });
});

describe("round-7: one full stop after the time", () => {
  const item = { id: "1", playerId: "hank", hole: 7, strokes: 4, enteredBy: "hank" };

  it("doesn't put two after the lock's time", () => {
    const locked = {
      code: "P0001",
      hint: "card_locked",
      message: "The card is locked by Hank Headpro, Nov 7, 3:02 AM.",
    };
    const line = refusalLine(null, item, locked, true);
    expect(line).toContain("Nov 7, 3:02 AM. It's your own card");
    expect(line).not.toContain("..");
  });
});
