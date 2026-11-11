import { describe, expect, it } from "vitest";

import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it("keeps a path on this site", () => {
    expect(safeNextPath("/join/moose-ridge")).toBe("/join/moose-ridge");
    expect(safeNextPath("/c/pukagolf/league?league=saturday")).toBe(
      "/c/pukagolf/league?league=saturday",
    );
  });

  it("falls back when there is nothing to go to", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("", "/profile")).toBe("/profile");
  });

  it("refuses anywhere off the site", () => {
    for (const raw of [
      "https://evil.example/login",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "join/moose-ridge",
      "/join\\..\\x",
      "/join\nSet-Cookie: x",
    ]) {
      expect(safeNextPath(raw), raw).toBe("/");
    }
  });
});
