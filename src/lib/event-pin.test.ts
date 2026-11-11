import { describe, expect, it } from "vitest";

import { pinProblem } from "./event-pin";

describe("pinProblem", () => {
  it("accepts an ordinary eight-digit PIN", () => {
    expect(pinProblem("40719263")).toBeNull();
  });

  it("wants exactly eight digits", () => {
    expect(pinProblem("1234567")).toMatch(/8 digits/);
    expect(pinProblem("123456789")).toMatch(/8 digits/);
    expect(pinProblem("1234abcd")).toMatch(/8 digits/);
    expect(pinProblem("")).toMatch(/8 digits/);
  });

  it("refuses a digit repeated eight times", () => {
    expect(pinProblem("00000000")).toMatch(/too easy/);
    expect(pinProblem("77777777")).toMatch(/too easy/);
  });

  it("refuses the runs the database refuses", () => {
    for (const pin of ["12345678", "87654321", "01234567", "11223344"]) {
      expect(pinProblem(pin)).toMatch(/too easy/);
    }
  });

  it("allows a PIN that merely contains a run", () => {
    // Only whole-PIN runs are refused; 1234 inside a longer PIN is fine.
    expect(pinProblem("91234508")).toBeNull();
  });
});
