import { describe, expect, it } from "vitest";

import { toCsv } from "./csv";

describe("toCsv", () => {
  it("joins plain cells with commas and ends every row with CRLF", () => {
    expect(toCsv([["Player", "Points"], ["Amy", 10]])).toBe("Player,Points\r\nAmy,10\r\n");
  });

  it("quotes cells with commas, quotes or line breaks", () => {
    expect(toCsv([['Smith, "Smitty"', "two\nlines"]])).toBe('"Smith, ""Smitty""","two\nlines"\r\n');
  });

  it("defuses text that a spreadsheet would run as a formula", () => {
    expect(toCsv([["=HYPERLINK(1)", "@sum", "+1", "-2"]])).toBe("'=HYPERLINK(1),'@sum,'+1,'-2\r\n");
  });

  it("leaves numbers, negative ones included, as numbers", () => {
    expect(toCsv([[-2, 0, 1.5]])).toBe("-2,0,1.5\r\n");
  });

  it("writes nothing for missing values and Yes/No for true/false", () => {
    expect(toCsv([[null, undefined, true, false, Number.NaN]])).toBe(",,Yes,No,\r\n");
  });
});
