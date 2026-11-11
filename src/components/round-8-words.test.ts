import { describe, expect, it } from "vitest";

import { describeAuditEntry, foldRepeats, ruleChanges, type ClubAuditEntry } from "@/lib/audit-words";
import { enteredOnPhone, type CardHistoryEntry } from "@/lib/useLiveRound";
import { playerStats, stillPlaying, summarise, type PlayerRound } from "@/lib/usePlayerRounds";
import { putBackDone, putBackQuestion } from "./LeagueAdmin";
import { orderHistory } from "./league/ScoreEntry";

/** The testers' eighth run: putting cleared scores back, the logs, the profile. */

const restorable = {
  roundId: "w3",
  count: 34,
  clearedAt: "2026-11-07T19:00:00Z",
  keptUntil: "2026-11-14T19:00:00Z",
};

describe("putting cleared scores back", () => {
  it("asks plainly when nothing has been scored since", () => {
    const question = putBackQuestion({ ...restorable, kept: 0 }, false);
    expect(question).toContain("Put the 34 scores back as they were?");
    expect(question).toContain("Sign-offs aren’t put back");
    expect(question).toMatch(/The cleared copy is kept until Sat, Nov 14, \d/);
  });

  it("after a new score, fills only the empty holes and says the new one stays", () => {
    const question = putBackQuestion({ ...restorable, kept: 2 }, false);
    expect(question).toContain("Put the 34 scores back into the holes that are still empty?");
    expect(question).toContain("2 holes scored since the clear keep their new score.");
    expect(putBackQuestion({ ...restorable, kept: 1 }, false)).toContain("1 hole scored since the clear keeps its new score.");
  });

  it("on a final week, says it stays final", () => {
    expect(putBackQuestion({ ...restorable, kept: 0 }, true)).toContain("The week stays final.");
  });

  it("says how many went back, and how many kept their new score", () => {
    expect(putBackDone("Week 3", 34, 2)).toBe("Put back 34 scores in Week 3; 2 holes kept their new score.");
    expect(putBackDone("Week 3", 13, 0)).toBe("Put back 13 scores in Week 3.");
  });

  it("works with a database from before 0060, which leaves out kept and keptUntil", () => {
    expect(putBackQuestion({ roundId: "w3", count: 5, clearedAt: "2026-11-07T19:00:00Z" }, false)).toMatch(
      /^Put the 5 scores back as they were\?.*kept until Sat, Nov 14/,
    );
  });
});

const entry = (over: Partial<ClubAuditEntry>): ClubAuditEntry => ({
  id: 1,
  at: "2026-11-07T22:00:00Z",
  actor: "Hank Headpro",
  action: "update",
  entity: "league_rules",
  entityId: "hrf",
  detail: null,
  player: null,
  week: null,
  league: "Hank Run Four",
  ...over,
});

const rules = (dropWorst: number, wasDropWorst: number) => ({
  points: [10, 8, 6],
  completion: 1,
  drop_worst: dropWorst,
  min_weeks: 0,
  ranking: "net",
  guests_score: false,
  default_stake: 0,
  default_game: "stroke",
  stableford: [5, 4, 3, 2, 1, 0],
  was: {
    points: [10, 8, 6],
    completion: 1,
    drop_worst: wasDropWorst,
    min_weeks: 0,
    ranking: "net",
    guests_score: false,
    default_stake: 0,
    default_game: "stroke",
    stableford: [5, 4, 3, 2, 1, 0],
  },
});

describe("the rules log", () => {
  it("names the rule that changed, from and to", () => {
    expect(describeAuditEntry(entry({ detail: rules(1, 0) }))).toBe(
      "changed Hank Run Four’s rules: Worst weeks dropped from 0 to 1",
    );
  });

  it("logs changing it back as its own line, which isn't folded into the first", () => {
    const there = entry({ id: 1, detail: rules(1, 0) });
    const back = entry({ id: 2, at: "2026-11-07T22:00:20Z", detail: rules(0, 1) });
    expect(describeAuditEntry(back)).toBe("changed Hank Run Four’s rules: Worst weeks dropped from 1 to 0");
    expect(foldRepeats([back, there])).toHaveLength(2);
  });

  it("names every rule a save changed", () => {
    const d = { ...rules(0, 0), ranking: "gross", guests_score: true };
    expect(ruleChanges(d)).toEqual(["Rank by from net to gross", "Guests take places and points from off to on"]);
  });

  it("keeps the old wording for a line from before 0060", () => {
    const old: Record<string, unknown> = rules(1, 0);
    delete old.was;
    expect(describeAuditEntry(entry({ detail: old }))).toBe("changed Hank Run Four’s rules");
  });

  it("says how many cleared scores were put back, and how many kept a new one", () => {
    expect(
      describeAuditEntry(
        entry({ entity: "round", action: "restore_scores", detail: { restored: 34, kept: 2, status: "final" } }),
      ),
    ).toBe("put back 34 of the week’s cleared scores in a final week; 2 holes kept their new score");
  });
});

describe("a hole held because PukaGolf didn't answer", () => {
  const item = { id: "1", playerId: "p", hole: 3, strokes: 5, enteredBy: "p", enteredAt: 1_000_000 };

  it("says when it was entered, like one held for signal", () => {
    // 37 seconds, as the testers' hole 3s waited: under the minute that marked one before.
    expect(enteredOnPhone({ ...item, tries: 1 }, 1_037_000)).toBe(new Date(1_000_000).toISOString());
    expect(enteredOnPhone({ ...item, held: true }, 1_005_000)).toBe(new Date(1_000_000).toISOString());
  });

  it("but a hole that went at once still doesn't", () => {
    expect(enteredOnPhone(item, 1_002_000)).toBeNull();
  });
});

const history = (at: string, hole: number | null, phoneAt: string | null = null): CardHistoryEntry => ({
  at,
  action: hole === null ? "sign_off" : "insert",
  entity: hole === null ? "card" : "score",
  by: "Greg",
  hole,
  strokes: 4,
  from: null,
  to: null,
  phoneAt,
});

describe("the card's history, in order", () => {
  // Holes 1 and 2 entered offline at 2:10 and 2:05 (corrected out of order),
  // arriving together at 2:20; hole 3 with signal at 2:15; signed at 2:30.
  const entries = [
    history("2026-11-07T14:20:00Z", 1, "2026-11-07T14:10:00Z"),
    history("2026-11-07T14:20:00Z", 2, "2026-11-07T14:05:00Z"),
    history("2026-11-07T14:15:00Z", 3),
    history("2026-11-07T14:30:00Z", null),
  ];

  it("goes by when each was entered", () => {
    expect(orderHistory(entries, "time").map((e) => e.hole)).toEqual([2, 1, 3, null]);
  });

  it("or hole by hole, the card's sign-off last", () => {
    expect(orderHistory(entries, "hole").map((e) => e.hole)).toEqual([1, 2, 3, null]);
  });
});

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

describe("the profile's numbers", () => {
  it("leave out this week's card until it's signed or the week is final", () => {
    const rounds = [
      round({ roundId: "now", status: "live", scores: { "1": 3, "2": 3 } }),
      round({ roundId: "before", playedOn: "2026-11-19" }),
    ].map((r) => summarise(r, null));
    const stats = playerStats(rounds, 2026);
    expect(stats.roundsThisSeason).toBe(1);
    expect(stats.scoringAverage).toBe(9);
    expect(stats.bestRound?.roundId).toBe("before");
  });

  it("count a live week's card once it's signed", () => {
    expect(stillPlaying({ status: "live", signed: true })).toBe(false);
    expect(stillPlaying({ status: "live" })).toBe(true);
    expect(stillPlaying({ status: "final" })).toBe(false);
    expect(playerStats([summarise(round({ status: "live", signed: true }), null)], 2026).roundsThisSeason).toBe(1);
  });
});
