/**
 * The same field, the same formats, through both storage adapters.
 *
 * A league week and an event keep their teams in different tables. That is
 * allowed to stay true only for as long as nothing above the adapters can
 * tell the difference, so every scenario here is built twice — once out of
 * round_teams rows, once out of event_teams rows — and the two results are
 * asserted to be identical.
 *
 * If a rule ever gets written into one adapter instead of into the shared
 * code, this is the file that fails.
 */

import { describe, expect, it } from "vitest";

import { buildGameBoard } from "../games";
import { checkField, draftTeams, pairMatches, type FieldPlayer } from "./field";
import { FORMATS, feedsHandicap, formatsForSize, getFormat, isGrossOnly } from "./registry";
import {
  fieldFromTeams,
  scoresFromEvent,
  sidesFromTeams,
  sideOf,
  teamsFromEvent,
  teamsFromRound,
  type EventScoreRow,
  type TeamSource,
} from "./teams";

/** Eight players, spread across the index range. */
const FIELD: FieldPlayer[] = [
  { id: "p1", name: "Jordan Fairway", handicapIndex: 1 },
  { id: "p2", name: "Bailey Chipper", handicapIndex: 7.8 },
  { id: "p3", name: "Drew Divot", handicapIndex: 8.5 },
  { id: "p4", name: "Casey Birdie", handicapIndex: 12 },
  { id: "p5", name: "Sam Golfer", handicapIndex: 14.6 },
  { id: "p6", name: "Alex Player", handicapIndex: 14.9 },
  { id: "p7", name: "Jamie Caddie", handicapIndex: 16.5 },
  { id: "p8", name: "Morgan Bunker", handicapIndex: 30 },
];

const PARS = { 1: 4, 2: 4, 3: 4, 4: 5, 5: 4, 6: 3, 7: 4, 8: 4, 9: 3 };

/** A card each, so every side has something to be ranked on. */
const CARDS: Record<string, number[]> = {
  p1: [4, 6, 5, 6, 4, 3, 4, 4, 3],
  p2: [4, 8, 6, 6, 6, 3, 5, 6, 4],
  p3: [4, 6, 6, 5, 5, 3, 4, 4, 5],
  p4: [6, 7, 5, 7, 5, 3, 5, 5, 3],
  p5: [5, 5, 5, 7, 6, 3, 6, 5, 5],
  p6: [5, 6, 5, 7, 6, 3, 4, 5, 3],
  p7: [4, 6, 6, 7, 5, 3, 4, 5, 3],
  p8: [5, 6, 5, 9, 5, 4, 5, 4, 5],
};

const scores = Object.entries(CARDS).flatMap(([playerId, card]) =>
  card.map((strokes, i) => ({ playerId, hole: i + 1, strokes })),
);

/** The same draft, stored the way a league week stores it. */
function asRound(teamSize: number): TeamSource {
  const { teams } = draftTeams(FIELD, teamSize);

  return teamsFromRound({
    roundId: "round-1",
    teams: teams.map((t) => ({ id: `t${t.position}`, name: null, position: t.position })),
    members: teams.flatMap((t) =>
      t.players.map((p, i) => ({ team_id: `t${t.position}`, player_id: p.id, position: i })),
    ),
    profiles: FIELD.map((p) => ({
      id: p.id,
      full_name: p.name,
      handicap_index: p.handicapIndex,
    })),
  });
}

/** The same draft, stored the way an event stores it. */
function asEvent(teamSize: number): TeamSource {
  const { teams } = draftTeams(FIELD, teamSize);

  return teamsFromEvent({
    eventId: "event-1",
    teams: teams.map((t) => ({ id: `t${t.position}`, name: null, position: t.position })),
    members: teams.flatMap((t) =>
      t.players.map((p) => ({ team_id: `t${t.position}`, player_id: p.id })),
    ),
    // An event roster carries the player's own row; here every one of them
    // happens to be a league member, which is the case that has to match.
    players: teams.flatMap((t) =>
      t.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        position: i,
        profile_id: p.id,
        handicap_index: p.handicapIndex,
      })),
    ),
  });
}

/** Everything a caller above the adapters can see. */
function observable(source: TeamSource) {
  return {
    teams: source.teams.map((t) => ({
      name: t.name,
      position: t.position,
      players: t.players.map((p) => [p.name, p.handicapIndex, p.position]),
    })),
    sides: sidesFromTeams(source),
    field: fieldFromTeams(source).map((p) => p.name),
    sideOfEach: FIELD.map((p) => sideOf(source, p.id)?.name ?? null),
  };
}

describe("the two adapters are interchangeable", () => {
  for (const size of [1, 2, 3, 4]) {
    it(`reads a field of ${FIELD.length} in ${size === 1 ? "singles" : `${size}s`} the same way`, () => {
      expect(observable(asEvent(size))).toEqual(observable(asRound(size)));
    });
  }

  it("only differs in which table it came from", () => {
    const round = asRound(2);
    const event = asEvent(2);

    expect(round.kind).toBe("round");
    expect(event.kind).toBe("event");
    expect(event.teams).toEqual(round.teams);
  });

  it("scores every format identically from either store", () => {
    for (const spec of FORMATS) {
      for (const size of spec.sizes) {
        const fromRound = buildGameBoard({
          game: spec.id,
          sides: sidesFromTeams(asRound(size)),
          scores,
          pars: PARS,
          holeCount: 9,
        });
        const fromEvent = buildGameBoard({
          game: spec.id,
          sides: sidesFromTeams(asEvent(size)),
          scores,
          pars: PARS,
          holeCount: 9,
        });

        expect(fromEvent, `${spec.id} in ${size}s`).toEqual(fromRound);
      }
    }
  });

  it("pairs the same matches from either store", () => {
    for (const size of [1, 2, 4]) {
      const fromRound = pairMatches(draftTeams(fieldFromTeams(asRound(size)), size).teams);
      const fromEvent = pairMatches(draftTeams(fieldFromTeams(asEvent(size)), size).teams);

      expect(fromEvent).toEqual(fromRound);
    }
  });

  it("keeps a guest with no account distinguishable, without changing the side", () => {
    const withGuest = teamsFromEvent({
      eventId: "event-2",
      teams: [{ id: "t1", name: null, position: 1 }],
      members: [
        { team_id: "t1", player_id: "e1" },
        { team_id: "t1", player_id: "e2" },
      ],
      players: [
        { id: "e1", name: "Sam Golfer", position: 0, profile_id: "p5", handicap_index: 14.6 },
        { id: "e2", name: "A mate of Owen's", position: 1, profile_id: null, handicap_index: null },
      ],
    });

    expect(withGuest.teams[0].players.map((p) => p.profileId)).toEqual(["p5", null]);
    // The side still scores as a side; only the handicap record cares.
    expect(sidesFromTeams(withGuest)).toEqual([{ id: "t1", playerIds: ["e1", "e2"] }]);
  });
});

describe("scoresFromEvent", () => {
  const side = teamsFromEvent({
    eventId: "e1",
    teams: [
      { id: "t1", name: null, position: 1 },
      { id: "t2", name: null, position: 2 },
    ],
    members: [
      { team_id: "t1", player_id: "a" },
      { team_id: "t1", player_id: "b" },
      { team_id: "t2", player_id: "c" },
    ],
    players: [
      { id: "a", name: "Amy", position: 0 },
      { id: "b", name: "Bob", position: 1 },
      { id: "c", name: "Cal", position: 0 },
    ],
  }).teams;

  it("hands a one-ball hole to everyone who played that ball", () => {
    expect(
      scoresFromEvent([{ teamId: "t1", playerId: null, hole: 1, strokes: 4 }], side),
    ).toEqual([
      { playerId: "a", hole: 1, strokes: 4 },
      { playerId: "b", hole: 1, strokes: 4 },
    ]);
  });

  it("leaves an own-ball hole with the player who made it", () => {
    expect(
      scoresFromEvent([{ teamId: "t1", playerId: "b", hole: 3, strokes: 5 }], side),
    ).toEqual([{ playerId: "b", hole: 3, strokes: 5 }]);
  });

  it("drops a row naming a side the player isn't on", () => {
    expect(
      scoresFromEvent([{ teamId: "t2", playerId: "a", hole: 1, strokes: 4 }], side),
    ).toEqual([]);
  });

  it("scores a scramble the same however the two stores wrote it down", () => {
    const pars = { 1: 4, 2: 4 };
    const oneBall: EventScoreRow[] = [
      { teamId: "t1", playerId: null, hole: 1, strokes: 4 },
      { teamId: "t1", playerId: null, hole: 2, strokes: 5 },
    ];
    // The same two holes, written the way a league week writes them.
    const perCard = [
      { playerId: "a", hole: 1, strokes: 4 },
      { playerId: "b", hole: 1, strokes: 4 },
      { playerId: "a", hole: 2, strokes: 5 },
      { playerId: "b", hole: 2, strokes: 5 },
    ];
    const sides = [{ id: "t1", playerIds: ["a", "b"] }];

    expect(
      buildGameBoard({ game: "scramble", sides, scores: scoresFromEvent(oneBall, side), pars, holeCount: 2 }),
    ).toEqual(
      buildGameBoard({ game: "scramble", sides, scores: perCard, pars, holeCount: 2 }),
    );
  });
});

describe("checkField", () => {
  it("gives the example from the spec, word for word", () => {
    const check = checkField({ players: 18, teamSize: 4, format: "best_ball" });

    expect(check).toMatchObject({ teams: 4, leftOver: 2, ready: false });
    expect(check.warnings[0].message).toBe(
      "18 players → 4 teams of 4, 2 left over. Add 2 players or pick an option.",
    );
    expect(check.warnings[0].fixes).toEqual([
      { kind: "add_players", count: 2 },
      { kind: "team_size", size: 2 },
      { kind: "bye" },
      { kind: "blind_draw" },
    ]);
  });

  it("is happy when the field divides", () => {
    expect(checkField({ players: 16, teamSize: 4, format: "best_ball" })).toMatchObject({
      teams: 4,
      leftOver: 0,
      ready: true,
    });
  });

  it("warns when a format that pairs sides has an odd number of them", () => {
    const check = checkField({ players: 6, teamSize: 2, format: "match" });

    expect(check.teams).toBe(3);
    expect(check.warnings.map((w) => w.kind)).toEqual(["odd_sides"]);
    expect(check.warnings[0].message).toContain("without an opponent");
  });

  it("does not warn about odd sides in a format that doesn't pair them", () => {
    expect(checkField({ players: 6, teamSize: 2, format: "best_ball" }).ready).toBe(true);
  });

  it("warns when the format isn't played at that size", () => {
    const check = checkField({ players: 8, teamSize: 4, format: "greensomes" });

    expect(check.warnings[0]).toMatchObject({ kind: "wrong_size" });
    expect(check.warnings[0].fixes).toEqual([{ kind: "team_size", size: 2 }]);
  });

  it("says so when there is barely a game", () => {
    expect(checkField({ players: 4, teamSize: 4, format: "scramble" }).warnings.map((w) => w.kind))
      .toEqual(["too_few"]);
  });

  /**
   * The headline is what an admin reads standing on the first tee, so it has
   * to say what is wrong on its own, without the sentence underneath it.
   */
  it("heads every warning with the thing that is wrong", () => {
    const headline = (players: number, teamSize: number, format: string) =>
      checkField({ players, teamSize, format }).warnings.map((w) => w.headline);

    expect(headline(18, 4, "best_ball")).toEqual(["2 players left over"]);
    expect(headline(17, 4, "best_ball")).toEqual(["1 player left over"]);
    expect(headline(6, 2, "match")).toEqual(["3 sides can't all be paired"]);
    expect(headline(4, 4, "scramble")).toEqual(["Not enough for a game"]);
    expect(headline(8, 4, "greensomes")).toEqual(["Greensomes isn't played in 4s"]);
  });
});

describe("draftTeams", () => {
  it("snakes, so the side that got the best player gets the worst of the next round", () => {
    const { teams } = draftTeams(FIELD, 2);

    expect(teams.map((t) => t.players.map((p) => p.name))).toEqual([
      ["Jordan Fairway", "Morgan Bunker"],
      ["Bailey Chipper", "Jamie Caddie"],
      ["Drew Divot", "Alex Player"],
      ["Casey Birdie", "Sam Golfer"],
    ]);

    // The point of the snake: combined indexes land within a few shots of
    // each other. Drafting straight down the order would put 1 and 7.8 on one
    // side and 16.5 and 30 on another.
    const totals = teams.map((t) =>
      t.players.reduce((sum, p) => sum + (p.handicapIndex ?? 0), 0),
    );
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(8);
  });

  it("leaves whoever doesn't fit, rather than making a short side", () => {
    const { teams, leftOver } = draftTeams(FIELD, 3);

    expect(teams).toHaveLength(2);
    expect(leftOver.map((p) => p.name)).toEqual(["Jamie Caddie", "Morgan Bunker"]);
  });

  it("drafts a player with no index last, not as a scratch player", () => {
    const { teams } = draftTeams(
      [...FIELD.slice(0, 3), { id: "px", name: "New player", handicapIndex: null }],
      2,
    );

    expect(teams[0].players.map((p) => p.name)).toEqual(["Jordan Fairway", "New player"]);
  });

  it("makes every player their own side in singles", () => {
    const { teams, leftOver } = draftTeams(FIELD, 1);

    expect(teams).toHaveLength(8);
    expect(leftOver).toEqual([]);
  });
});

describe("the registry", () => {
  it("offers every size a real set of formats", () => {
    for (const size of [1, 2, 3, 4]) {
      expect(formatsForSize(size).length).toBeGreaterThan(0);
    }
  });

  it("covers the formats asked for, at the sizes asked for", () => {
    expect(formatsForSize(1).map((f) => f.id)).toEqual([
      "stroke",
      "net_stroke",
      "stableford",
      "skins",
      "match",
    ]);
    expect(formatsForSize(2).map((f) => f.id)).toEqual([
      "match",
      "best_ball",
      "scramble",
      "alt_shot",
      "greensomes",
    ]);
    expect(formatsForSize(3).map((f) => f.id)).toEqual([
      "match",
      "best_ball",
      "two_best",
      "scramble",
      "nines",
    ]);
    expect(formatsForSize(4).map((f) => f.id)).toEqual([
      "match",
      "best_ball",
      "two_best",
      "scramble",
    ]);
  });

  it("has no Ryder Cup, which is its own project", () => {
    expect(FORMATS.some((f) => f.id.includes("ryder"))).toBe(false);
  });

  it("still answers to the names already in the database", () => {
    expect(getFormat("solo").id).toBe("stroke");
    expect(getFormat("scramble_4").id).toBe("scramble");
    expect(getFormat("best_ball_2").id).toBe("best_ball");
    // And to the four the league has been using since the games work.
    for (const id of ["stroke", "stableford", "scramble", "best_ball"]) {
      expect(getFormat(id).id).toBe(id);
    }
  });

  it("plays one-ball formats gross, and only own-ball formats feed a handicap", () => {
    expect(FORMATS.filter((f) => f.ball === "one").map((f) => f.id)).toEqual([
      "scramble",
      "alt_shot",
      "greensomes",
    ]);

    // The two questions are the same question asked from opposite ends: a
    // score the side shares is nobody's own, so it can't reach an index.
    for (const spec of FORMATS) {
      expect(isGrossOnly(spec)).toBe(spec.ball === "one");
      expect(feedsHandicap(spec)).toBe(!isGrossOnly(spec));
    }
  });
});
