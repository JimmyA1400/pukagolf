import { describe, expect, it } from "vitest";

import { formatUsPhone, fromE164, isValidUsPhone, toE164 } from "./phone";

describe("formatUsPhone", () => {
  it("formats a full number", () => {
    expect(formatUsPhone("3135550142")).toBe("(313) 555-0142");
  });

  it("formats partial input as far as it goes", () => {
    // The mask must not insert punctuation the user hasn't reached.
    expect(formatUsPhone("3")).toBe("(3");
    expect(formatUsPhone("313")).toBe("(313");
    expect(formatUsPhone("313555")).toBe("(313) 555");
    expect(formatUsPhone("31355501")).toBe("(313) 555-01");
  });

  it("ignores punctuation the user types", () => {
    expect(formatUsPhone("(313) 555-0142")).toBe("(313) 555-0142");
    expect(formatUsPhone("313.555.0142")).toBe("(313) 555-0142");
  });

  it("treats a leading 1 as the country code", () => {
    expect(formatUsPhone("13135550142")).toBe("(313) 555-0142");
  });

  it("stops at ten digits", () => {
    expect(formatUsPhone("31355501429999")).toBe("(313) 555-0142");
  });

  it("returns empty for empty input", () => {
    expect(formatUsPhone("")).toBe("");
    expect(formatUsPhone("abc")).toBe("");
  });
});

describe("toE164", () => {
  it("stores a valid number in E.164", () => {
    expect(toE164("(313) 555-0142")).toBe("+13135550142");
  });

  it("accepts a leading country code", () => {
    expect(toE164("1 313 555 0142")).toBe("+13135550142");
    expect(toE164("+1 (313) 555-0142")).toBe("+13135550142");
  });

  it("rejects a number that is too short or too long", () => {
    expect(toE164("31355501")).toBeNull();
    expect(toE164("313555014299")).toBeNull();
  });

  it("rejects area codes and exchanges starting with 0 or 1", () => {
    // North American numbering forbids these, and they are what people type
    // to skip the field.
    expect(toE164("1135550142")).toBeNull();
    expect(toE164("0135550142")).toBeNull();
    expect(toE164("3131550142")).toBeNull();
  });

  it("rejects empty and junk", () => {
    expect(toE164("")).toBeNull();
    expect(toE164("not a phone")).toBeNull();
  });
});

describe("isValidUsPhone", () => {
  it("agrees with toE164", () => {
    expect(isValidUsPhone("(313) 555-0142")).toBe(true);
    expect(isValidUsPhone("123")).toBe(false);
  });
});

describe("fromE164", () => {
  it("renders a stored number for display", () => {
    expect(fromE164("+13135550142")).toBe("(313) 555-0142");
  });

  it("handles a missing number", () => {
    expect(fromE164(null)).toBe("");
    expect(fromE164(undefined)).toBe("");
  });

  it("round-trips", () => {
    const typed = "(313) 555-0142";

    expect(fromE164(toE164(typed))).toBe(typed);
  });
});
