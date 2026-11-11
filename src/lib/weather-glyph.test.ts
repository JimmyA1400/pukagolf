import { describe, expect, it } from "vitest";

import { weatherGlyph } from "./weather";

describe("weatherGlyph", () => {
  it("turns the sun on a clear day", () => {
    expect(weatherGlyph("Clear sky")).toEqual({ icon: "☀️", motion: "spin" });
  });

  it("drifts cloud, overcast or partly", () => {
    expect(weatherGlyph("Overcast").motion).toBe("drift");
    expect(weatherGlyph("Partly cloudy")).toEqual({ icon: "⛅", motion: "drift" });
  });

  it("drops rain, drizzle, showers and snow", () => {
    for (const summary of ["Light rain", "Drizzle", "Rain showers", "Snow"]) {
      expect(weatherGlyph(summary).motion).toBe("fall");
    }
  });

  it("calls a storm a storm before it calls it rain", () => {
    // "Thunderstorm with rain" contains both words; the flicker should win.
    expect(weatherGlyph("Thunderstorm with rain")).toEqual({
      icon: "⛈️",
      motion: "flash",
    });
  });

  it("lets fog breathe", () => {
    expect(weatherGlyph("Fog").motion).toBe("breathe");
  });

  it("falls back to the sun for wording it does not know", () => {
    expect(weatherGlyph("Something new").motion).toBe("spin");
  });
});
