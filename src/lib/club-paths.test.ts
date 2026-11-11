import { describe, expect, it } from "vitest";

import { clubPath, pickLeague, type ClubLeague } from "./club-paths";

const saturday: ClubLeague = { id: "s", slug: "saturday", name: "Saturday", plays: false };
const thursday: ClubLeague = { id: "t", slug: "thursday", name: "Thursday", plays: true };
const sunday: ClubLeague = { id: "u", slug: "sunday", name: "Sunday", plays: true };

describe("pickLeague", () => {
  it("shows the league the address names", () => {
    expect(pickLeague([saturday, thursday], "saturday")).toBe(saturday);
  });

  it("otherwise shows the first league the player plays in", () => {
    expect(pickLeague([saturday, thursday, sunday], null)).toBe(thursday);
  });

  it("ignores a league the caller can't see, rather than showing nothing", () => {
    // my_clubs() only lists visible leagues, so an unknown slug is one of those.
    expect(pickLeague([saturday, thursday], "wednesday")).toBe(thursday);
  });

  it("falls back to the first league for staff who play in none", () => {
    expect(pickLeague([saturday], null)).toBe(saturday);
  });

  it("has nothing to show in a club without a league", () => {
    expect(pickLeague([], "saturday")).toBeNull();
  });
});

describe("clubPath", () => {
  const leagues = [saturday, thursday, sunday];

  it("puts a path inside the club", () => {
    expect(clubPath("moose-ridge", "/league/events", thursday, leagues)).toBe(
      "/c/moose-ridge/league/events",
    );
  });

  it("leaves the league out when it is the one the club shows anyway", () => {
    expect(clubPath("moose-ridge", "/league", thursday, leagues)).toBe("/c/moose-ridge/league");
  });

  it("names any other league, so a link keeps the league being looked at", () => {
    expect(clubPath("moose-ridge", "/league", sunday, leagues)).toBe(
      "/c/moose-ridge/league?league=sunday",
    );
  });

  it("adds to a query the path already has", () => {
    expect(clubPath("moose-ridge", "/league/print?group=2", sunday, leagues)).toBe(
      "/c/moose-ridge/league/print?group=2&league=sunday",
    );
  });

  it("accepts a path without its leading slash", () => {
    expect(clubPath("pukagolf", "admin", null, [])).toBe("/c/pukagolf/admin");
  });
});

describe("round-7: a past week's link in another league", () => {
  const leagues = [
    { id: "t", slug: "thursday", name: "Thursday", plays: true },
    { id: "s", slug: "sunday", name: "Sunday", plays: false },
  ];

  it("keeps the league and the week, with one question mark", () => {
    expect(clubPath("practice-ridge", "/league?week=w1", leagues[1], leagues)).toBe(
      "/c/practice-ridge/league?week=w1&league=sunday",
    );
  });
});
