import { describe, expect, it } from "vitest";

import { foldRepeats, type ClubAuditEntry } from "@/lib/audit-words";
import type { CardHistoryEntry } from "@/lib/useLiveRound";
import { playerStats, summarise, type PlayerRound } from "@/lib/usePlayerRounds";
import { handicapWait } from "./PlayerRecord";
import { orderHistory } from "./league/ScoreEntry";

/** The testers' ninth run: the card's history, the log, the handicap. */

const line = (over: Partial<CardHistoryEntry>): CardHistoryEntry => ({
  at: "2026-11-09T14:20:00Z",
  action: "insert",
  entity: "score",
  by: "Hank",
  hole: 1,
  strokes: 4,
  from: null,
  to: null,
  ...over,
});

describe("the card's history", () => {
  it("leaves out a save that changed nothing", () => {
    const entries = [
      line({ action: "update", hole: 2, from: 5, to: 5 }),
      line({ action: "update", hole: 3, from: 3, to: 4 }),
    ];
    expect(orderHistory(entries, "time").map((e) => e.hole)).toEqual([3]);
  });

  it("puts a clear's lines, all written in one moment, in hole order", () => {
    const cleared = [2, 3, 4, 5, 7, 9, 8, 1, 6].map((hole) =>
      line({ action: "delete", hole, reason: "Cleared with “Clear all”" }),
    );
    expect(orderHistory(cleared, "time").map((e) => e.hole)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("the club's log", () => {
  it("leaves out a hole saved again with the number it had", () => {
    const entry = (id: number, from: number, to: number): ClubAuditEntry => ({
      id,
      at: "2026-11-09T14:20:00Z",
      actor: "Hank Headpro",
      action: "update",
      entity: "score",
      entityId: String(id),
      detail: { hole: id, from, to },
      player: "Hank Headpro",
      week: "Week 6 · Hank Run Four",
    });
    expect(foldRepeats([entry(2, 5, 5), entry(3, 3, 3), entry(4, 4, 5)]).map((e) => e.id)).toEqual([4]);
  });
});

describe("the handicap, while it's still self-reported", () => {
  it("says a nine counts as a round", () => {
    expect(handicapWait(3, 0)).toBe("Self-reported. 3 more rounds (9 or 18 holes) to calculate.");
    expect(handicapWait(1, 0)).toBe("Self-reported. 1 more round (9 or 18 holes) to calculate.");
  });

  it("says why signed rounds aren't counting, rather than asking for more", () => {
    expect(handicapWait(3, 6)).toContain("6 rounds don’t count yet: there’s no tee on record to rate them by.");
    expect(handicapWait(3, 1)).toContain("1 round doesn’t count yet");
  });

  it("counts a finished round with no rating as one that can't count", () => {
    const round = (over: Partial<PlayerRound>): PlayerRound => ({
      roundId: "r",
      name: "Week",
      playedOn: "2026-11-26",
      status: "final",
      courseName: "Practice Ridge",
      holeCount: 2,
      tee: null,
      courseRating: null,
      slope: null,
      coursePar: 8,
      scores: { "1": 4, "2": 5 },
      pars: { "1": 4, "2": 4 },
      strokeIndexes: {},
      ...over,
    });
    expect(playerStats([summarise(round({}), null)], 2026).unratedRounds).toBe(1);
  });
});
