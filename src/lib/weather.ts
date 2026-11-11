/**
 * Weather from Open-Meteo.
 *
 * Chosen over commercial providers because it needs no API key: nothing to sign
 * up for, no secret to keep out of the repo, and no key to rotate. Response
 * shapes below were observed against the live API, not assumed.
 */

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type Place = Coordinates & {
  name: string;
  /** State or region, absent for some places. */
  admin1: string | null;
  country: string;
  timezone: string;
};

export type Conditions = {
  tempF: number;
  feelsLikeF: number;
  humidity: number;
  /** WMO code translated to words. */
  summary: string;
  windMph: number;
  windGustMph: number;
  /** Compass point, e.g. "NE". */
  windFrom: string;
  rainChance: number;
  /** Local clock time, e.g. "7:36pm". */
  sunset: string;
  /** When this reading was taken, local to the course. */
  observedAt: string;
};

/**
 * WMO weather codes, worded for a golfer rather than a meteorologist — what
 * matters on a course is whether it's playable, not the precise taxonomy.
 */
const WMO: Record<number, string> = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "heavy showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorms",
  96: "thunderstorms with hail",
  99: "thunderstorms with hail",
};

export function describeWeatherCode(code: number): string {
  return WMO[code] ?? "unsettled";
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/**
 * Meteorological wind direction is the direction wind comes FROM, which is the
 * convention golfers use too ("into a north wind").
 */
export function windCompass(degrees: number): string {
  const index = Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16;

  return COMPASS[index];
}

/** "7:36pm" from an ISO local timestamp, without dragging in a date library. */
export function clockTime(isoLocal: string): string {
  const time = isoLocal.split("T")[1];
  if (!time) return isoLocal;

  const [rawHours, minutes] = time.split(":");
  const hours = Number(rawHours);
  const suffix = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;

  return `${hour12}:${minutes}${suffix}`;
}

const FORECAST_FIELDS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "weather_code",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
].join(",");

type ForecastResponse = {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
  };
  daily: {
    sunset: string[];
    precipitation_probability_max: (number | null)[];
  };
};

export function forecastUrl({ latitude, longitude }: Coordinates): string {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: FORECAST_FIELDS,
    daily: "sunset,precipitation_probability_max",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    // Times come back in the course's local zone, which is what players want.
    timezone: "auto",
    forecast_days: "1",
  });

  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

export function toConditions(data: ForecastResponse): Conditions {
  const { current, daily } = data;

  return {
    tempF: Math.round(current.temperature_2m),
    feelsLikeF: Math.round(current.apparent_temperature),
    humidity: Math.round(current.relative_humidity_2m),
    summary: describeWeatherCode(current.weather_code),
    windMph: Math.round(current.wind_speed_10m),
    windGustMph: Math.round(current.wind_gusts_10m),
    windFrom: windCompass(current.wind_direction_10m),
    rainChance: daily.precipitation_probability_max?.[0] ?? 0,
    sunset: clockTime(daily.sunset?.[0] ?? ""),
    observedAt: clockTime(current.time),
  };
}

export function geocodeUrl(query: string): string {
  const params = new URLSearchParams({
    name: query,
    count: "5",
    language: "en",
    format: "json",
  });

  return `https://geocoding-api.open-meteo.com/v1/search?${params}`;
}

type GeocodeResponse = {
  results?: {
    name: string;
    latitude: number;
    longitude: number;
    admin1?: string;
    country: string;
    timezone: string;
  }[];
};

export function toPlaces(data: GeocodeResponse): Place[] {
  return (data.results ?? []).map((r) => ({
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    admin1: r.admin1 ?? null,
    country: r.country,
    timezone: r.timezone,
  }));
}

/** "Pinehurst, North Carolina" — country only when it isn't the US. */
export function describePlace(place: Place): string {
  const parts = [place.name, place.admin1].filter(Boolean);
  if (place.country !== "United States") parts.push(place.country);

  return parts.join(", ");
}

export type WeatherMotion = "spin" | "drift" | "fall" | "flash" | "breathe";

/**
 * The icon for a worded summary, and how it should move.
 *
 * Matches on the words describeWeatherCode produces rather than the raw WMO
 * code, so if that wording changes the buckets follow it. Order matters:
 * "thunderstorm with rain" is a storm before it is rain.
 */
export function weatherGlyph(summary: string): {
  icon: string;
  motion: WeatherMotion;
} {
  const text = summary.toLowerCase();

  if (text.includes("thunder")) return { icon: "⛈️", motion: "flash" };
  if (text.includes("snow") || text.includes("ice")) {
    return { icon: "🌨️", motion: "fall" };
  }
  if (text.includes("rain") || text.includes("drizzle")) {
    return { icon: "🌧️", motion: "fall" };
  }
  if (text.includes("shower")) return { icon: "🌦️", motion: "fall" };
  if (text.includes("fog") || text.includes("mist")) {
    return { icon: "🌫️", motion: "breathe" };
  }
  if (text.includes("overcast")) return { icon: "☁️", motion: "drift" };
  if (text.includes("cloud")) return { icon: "⛅", motion: "drift" };

  return { icon: "☀️", motion: "spin" };
}
