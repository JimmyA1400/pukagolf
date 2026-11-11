import { describe, expect, it } from "vitest";

import { clubFromHost, clubPathFor } from "./club-host";

describe("clubFromHost", () => {
  it("reads the club from its subdomain", () => {
    expect(clubFromHost("moose-ridge.pukagolf.com", "pukagolf.com")).toBe("moose-ridge");
  });

  it("ignores a port and letter case", () => {
    expect(clubFromHost("Moose-Ridge.PukaGolf.com:443", "pukagolf.com")).toBe("moose-ridge");
  });

  it("is off until the root domain is set", () => {
    expect(clubFromHost("moose-ridge.pukagolf.com", undefined)).toBeNull();
  });

  it("treats the root domain and www as the site, not a club", () => {
    expect(clubFromHost("pukagolf.com", "pukagolf.com")).toBeNull();
    expect(clubFromHost("www.pukagolf.com", "pukagolf.com")).toBeNull();
  });

  it("ignores other hosts, such as Vercel's own addresses", () => {
    expect(clubFromHost("pukagolf.vercel.app", "pukagolf.com")).toBeNull();
    expect(clubFromHost("evilpukagolf.com", "pukagolf.com")).toBeNull();
  });

  it("only takes one label", () => {
    expect(clubFromHost("a.b.pukagolf.com", "pukagolf.com")).toBeNull();
  });
});

describe("clubPathFor", () => {
  it("opens the club's league at its front door", () => {
    expect(clubPathFor("moose-ridge", "/")).toBe("/c/moose-ridge/league");
  });

  it("puts a club page inside the club", () => {
    expect(clubPathFor("moose-ridge", "/league/events")).toBe("/c/moose-ridge/league/events");
  });

  it("leaves the site's own pages alone", () => {
    for (const path of ["/sign-in", "/join/moose-ridge", "/profile", "/players/1", "/event/abc", "/api/weather", "/c/moose-ridge/league"]) {
      expect(clubPathFor("moose-ridge", path), path).toBeNull();
    }
  });
});
