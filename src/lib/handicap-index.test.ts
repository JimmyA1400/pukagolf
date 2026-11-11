import { describe, expect, it } from "vitest";

import {
  formatHandicapIndex,
  isPlusHandicap,
  parseHandicapInput,
} from "./handicap-index";

const value = (input: string) => {
  const parsed = parseHandicapInput(input);

  return parsed.ok ? parsed.value : null;
};

describe("parseHandicapInput", () => {
  it("reads an ordinary handicap", () => {
    expect(value("12.4")).toBe(12.4);
    expect(value("0")).toBe(0);
    expect(value("54")).toBe(54);
  });

  it("stores a plus handicap as negative", () => {
    // "+1.4" means 1.4 BETTER than scratch. Storing it as positive would make
    // the best player in the league look like the worst.
    expect(value("+1.4")).toBe(-1.4);
    expect(value("+0.6")).toBe(-0.6);
  });

  it("treats a typed minus the same as a plus", () => {
    // Golfers write "+1.4"; the arithmetic convention is "-1.4". Same player.
    expect(value("-1.4")).toBe(-1.4);
  });

  it("accepts a whole number without a decimal", () => {
    expect(value("18")).toBe(18);
  });

  it("ignores surrounding whitespace", () => {
    expect(value("  12.4  ")).toBe(12.4);
  });

  it("rejects more than one decimal place", () => {
    expect(parseHandicapInput("12.45").ok).toBe(false);
  });

  it("rejects values beyond the allowed range", () => {
    expect(parseHandicapInput("54.1").ok).toBe(false);
    expect(parseHandicapInput("+10.1").ok).toBe(false);
  });

  it("accepts the exact boundaries", () => {
    expect(value("54.0")).toBe(54);
    expect(value("+10.0")).toBe(-10);
  });

  it("rejects empty input with a usable message", () => {
    const parsed = parseHandicapInput("");

    expect(parsed).toMatchObject({ ok: false });
    expect((parsed as { reason: string }).reason).toMatch(/enter a handicap/i);
  });

  it("rejects junk", () => {
    for (const bad of ["abc", "1.2.3", "++1", "1,4", "-"]) {
      expect(parseHandicapInput(bad).ok).toBe(false);
    }
  });

  it("does not drift on values that divide badly in binary", () => {
    expect(value("0.3")).toBe(0.3);
    expect(value("2.9")).toBe(2.9);
  });
});

describe("formatHandicapIndex", () => {
  it("shows a plus handicap the way golfers write it", () => {
    expect(formatHandicapIndex(-1.4)).toBe("+1.4");
  });

  it("shows an ordinary handicap plainly", () => {
    expect(formatHandicapIndex(12.4)).toBe("12.4");
    expect(formatHandicapIndex(0)).toBe("0.0");
  });

  it("always shows one decimal", () => {
    expect(formatHandicapIndex(18)).toBe("18.0");
  });

  it("shows a dash when there is no index", () => {
    expect(formatHandicapIndex(null)).toBe("—");
    expect(formatHandicapIndex(undefined)).toBe("—");
  });

  it("round-trips with the parser", () => {
    for (const typed of ["12.4", "+1.4", "0.0", "54.0"]) {
      expect(formatHandicapIndex(value(typed))).toBe(typed);
    }
  });
});

describe("isPlusHandicap", () => {
  it("is true only below scratch", () => {
    expect(isPlusHandicap(-1.4)).toBe(true);
    expect(isPlusHandicap(0)).toBe(false);
    expect(isPlusHandicap(12.4)).toBe(false);
  });
});
