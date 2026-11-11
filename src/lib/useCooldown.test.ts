import { describe, expect, it } from "vitest";

import { secondsLeft, TEXT_COOLDOWN_SECONDS } from "./useCooldown";

describe("secondsLeft", () => {
  it("counts down in whole seconds, rounding up", () => {
    expect(secondsLeft(60_000, 0)).toBe(60);
    expect(secondsLeft(60_000, 59_001)).toBe(1);
  });

  it("stops at zero", () => {
    expect(secondsLeft(60_000, 60_000)).toBe(0);
    expect(secondsLeft(60_000, 90_000)).toBe(0);
  });

  it("waits a minute between texts, as Supabase does per number", () => {
    expect(TEXT_COOLDOWN_SECONDS).toBe(60);
  });
});
