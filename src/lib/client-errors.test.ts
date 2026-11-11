import { describe as suite, expect, it } from "vitest";

import { describe, safePath } from "./client-errors";

suite("safePath", () => {
  it("takes an outing's link out of the path", () => {
    // The token in the path is the outing's access; logging it hands it out.
    expect(safePath("/event/4af454d0b54143ed9fa73551f56b30a6")).toBe(
      "/event/[token]",
    );
  });

  it("keeps what comes after the token", () => {
    expect(safePath("/event/4af454d0b54143ed9fa73551f56b30a6/admin")).toBe(
      "/event/[token]/admin",
    );
  });

  it("leaves every other page alone", () => {
    expect(safePath("/league")).toBe("/league");
    expect(safePath("/tournaments/9b1c")).toBe("/tournaments/9b1c");
  });
});

suite("describe", () => {
  it("uses an Error's message", () => {
    expect(describe(new Error("Round not loaded."))).toBe("Round not loaded.");
  });

  it("falls back to the error's name when there is no message", () => {
    expect(describe(new TypeError())).toBe("TypeError");
  });

  it("passes strings through", () => {
    expect(describe("offline")).toBe("offline");
  });

  it("writes out a rejected object", () => {
    expect(describe({ code: "42501" })).toBe('{"code":"42501"}');
  });
});
