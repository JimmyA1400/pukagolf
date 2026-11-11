import { describe, expect, it } from "vitest";

import {
  clockTime,
  describePlace,
  describeWeatherCode,
  forecastUrl,
  geocodeUrl,
  toConditions,
  toPlaces,
  windCompass,
} from "./weather";

/** A real Open-Meteo response, captured from the live API. */
const FORECAST = {
  current: {
    time: "2026-09-07T14:15",
    temperature_2m: 83.7,
    apparent_temperature: 84.1,
    relative_humidity_2m: 40,
    weather_code: 0,
    wind_speed_10m: 11,
    wind_direction_10m: 57,
    wind_gusts_10m: 14.5,
  },
  daily: {
    sunset: ["2026-09-07T19:36"],
    precipitation_probability_max: [5],
  },
};

describe("windCompass", () => {
  it.each([
    [0, "N"],
    [45, "NE"],
    [90, "E"],
    [180, "S"],
    [270, "W"],
    [350, "N"],
  ])("reads %i degrees as %s", (degrees, expected) => {
    expect(windCompass(degrees)).toBe(expected);
  });

  it("handles the wrap at 360 without falling off the end of the table", () => {
    expect(windCompass(360)).toBe("N");
    expect(windCompass(720)).toBe("N");
  });

  it("handles a negative bearing", () => {
    expect(windCompass(-90)).toBe("W");
  });
});

describe("clockTime", () => {
  it("converts to 12-hour with a suffix", () => {
    expect(clockTime("2026-09-07T19:36")).toBe("7:36pm");
    expect(clockTime("2026-09-07T06:55")).toBe("6:55am");
  });

  it("renders midnight and noon as 12, not 0", () => {
    expect(clockTime("2026-09-07T00:10")).toBe("12:10am");
    expect(clockTime("2026-09-07T12:05")).toBe("12:05pm");
  });

  it("returns the input unchanged when there is no time part", () => {
    expect(clockTime("nonsense")).toBe("nonsense");
  });
});

describe("describeWeatherCode", () => {
  it("words the common codes for a golfer", () => {
    expect(describeWeatherCode(0)).toBe("clear");
    expect(describeWeatherCode(3)).toBe("overcast");
    expect(describeWeatherCode(95)).toBe("thunderstorms");
  });

  it("falls back rather than showing a bare number", () => {
    expect(describeWeatherCode(1234)).toBe("unsettled");
  });
});

describe("toConditions", () => {
  const conditions = toConditions(FORECAST);

  it("rounds temperatures to whole degrees", () => {
    expect(conditions.tempF).toBe(84);
    expect(conditions.feelsLikeF).toBe(84);
  });

  it("reads wind as speed, gusts and the direction it comes from", () => {
    expect(conditions.windMph).toBe(11);
    expect(conditions.windGustMph).toBe(15);
    expect(conditions.windFrom).toBe("ENE");
  });

  it("takes today's sunset and rain chance", () => {
    expect(conditions.sunset).toBe("7:36pm");
    expect(conditions.rainChance).toBe(5);
  });

  it("defaults rain chance to zero when the API omits it", () => {
    const sparse = {
      ...FORECAST,
      daily: { ...FORECAST.daily, precipitation_probability_max: [null] },
    };

    expect(toConditions(sparse).rainChance).toBe(0);
  });
});

describe("urls", () => {
  it("asks for Fahrenheit, mph and the course's own timezone", () => {
    const url = forecastUrl({ latitude: 35.19543, longitude: -79.46948 });

    expect(url).toContain("temperature_unit=fahrenheit");
    expect(url).toContain("wind_speed_unit=mph");
    expect(url).toContain("timezone=auto");
    expect(url).toContain("latitude=35.19543");
  });

  it("escapes a search query rather than pasting it in raw", () => {
    expect(geocodeUrl("St Andrews & Co")).toContain(
      "name=St+Andrews+%26+Co",
    );
  });
});

describe("toPlaces", () => {
  const raw = {
    results: [
      {
        name: "Pinehurst",
        latitude: 35.19543,
        longitude: -79.46948,
        admin1: "North Carolina",
        country: "United States",
        timezone: "America/New_York",
      },
      {
        name: "St Andrews",
        latitude: 56.33871,
        longitude: -2.79902,
        country: "United Kingdom",
        timezone: "Europe/London",
      },
    ],
  };

  it("normalises a missing region to null rather than undefined", () => {
    expect(toPlaces(raw)[1].admin1).toBeNull();
  });

  it("returns an empty list when nothing matched", () => {
    expect(toPlaces({})).toEqual([]);
  });

  it("omits the country for US places and keeps it otherwise", () => {
    const [pinehurst, standrews] = toPlaces(raw);

    expect(describePlace(pinehurst)).toBe("Pinehurst, North Carolina");
    expect(describePlace(standrews)).toBe("St Andrews, United Kingdom");
  });
});
