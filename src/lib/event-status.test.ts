import { describe, expect, it } from "vitest";

import {
  canDeleteEvent,
  deleteRefusal,
  eventStatus,
  type EventActivity,
} from "./event-status";

const TODAY = "2026-09-10";

const event = (over: Partial<EventActivity> = {}): EventActivity => ({
  completedAt: null,
  playedOn: TODAY,
  scoreCount: 0,
  ...over,
});

describe("eventStatus", () => {
  it("calls a closed-out outing completed, whenever it was played", () => {
    expect(
      eventStatus(
        event({ completedAt: "2026-09-01T18:00:00Z", playedOn: "2026-12-25" }),
        TODAY,
      ),
    ).toBe("completed");
  });

  it("calls a future outing upcoming, even with scores on it", () => {
    // Scores on a future date mean somebody tested it, not that it is live.
    expect(
      eventStatus(event({ playedOn: "2026-09-11", scoreCount: 4 }), TODAY),
    ).toBe("upcoming");
  });

  it("calls today's outing live once there are scores", () => {
    expect(eventStatus(event({ scoreCount: 1 }), TODAY)).toBe("live");
  });

  it("does not call today's outing live before anyone has scored", () => {
    expect(eventStatus(event(), TODAY)).toBe("abandoned");
  });

  it("calls a past outing that was never closed out abandoned", () => {
    expect(
      eventStatus(event({ playedOn: "2026-08-01", scoreCount: 40 }), TODAY),
    ).toBe("abandoned");
  });
});

describe("canDeleteEvent", () => {
  it("refuses only the outing someone may be part-way round", () => {
    expect(canDeleteEvent(event({ scoreCount: 1 }), TODAY)).toBe(false);
  });

  it("allows one created by mistake this morning", () => {
    // No scores, so there is nothing to lose.
    expect(canDeleteEvent(event(), TODAY)).toBe(true);
  });

  it("allows completed and abandoned outings", () => {
    expect(
      canDeleteEvent(event({ completedAt: "2026-09-10T20:00:00Z" }), TODAY),
    ).toBe(true);
    expect(
      canDeleteEvent(event({ playedOn: "2026-08-01", scoreCount: 40 }), TODAY),
    ).toBe(true);
  });

  it("allows a future outing to be cancelled", () => {
    expect(canDeleteEvent(event({ playedOn: "2026-10-01" }), TODAY)).toBe(true);
  });

  it("explains itself only when it refuses", () => {
    expect(deleteRefusal(event(), TODAY)).toBeNull();
    expect(deleteRefusal(event({ scoreCount: 1 }), TODAY)).toMatch(
      /close it out/i,
    );
  });

  it("never allows the home page's demo to be deleted", () => {
    // Even abandoned and scoreless, which would otherwise be the easiest case.
    const demo = event({ playedOn: "2026-08-01", isDemo: true });

    expect(canDeleteEvent(demo, TODAY)).toBe(false);
    expect(deleteRefusal(demo, TODAY)).toMatch(/demo/i);
  });
});
