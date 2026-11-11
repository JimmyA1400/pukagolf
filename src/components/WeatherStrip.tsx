"use client";

import { useEffect, useState } from "react";

import {
  weatherGlyph,
  type Conditions,
  type WeatherMotion,
} from "@/lib/weather";

/** Refresh cadence. Conditions on a course don't turn over faster than this. */
const REFRESH_MS = 15 * 60 * 1000;

type WeatherStripProps = {
  courseName: string;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * Side padding, so the strip's text lines up with the page under it. The
   * league and the outings use different phone margins, and a strip that
   * picked one would sit out of line on the other.
   */
  edge?: string;
  /**
   * An outing's link. Its page needs no account, so its weather is looked up
   * by the link (the server uses the outing's own place) rather than by an
   * account's sign-in.
   */
  eventToken?: string;
};

/** Full literal class names: Tailwind only emits classes it can find as text. */
const MOTION: Record<WeatherMotion, string> = {
  spin: "motion-safe:animate-weather-spin",
  drift: "motion-safe:animate-weather-drift",
  fall: "motion-safe:animate-weather-fall",
  flash: "motion-safe:animate-weather-flash",
  breathe: "motion-safe:animate-weather-breathe",
};

/**
 * One reading per place at a time. A page that draws the strip twice in a
 * row (React does so on purpose while developing, and an outing page can
 * render before and after its own data arrives) shares the request already
 * on its way instead of asking again: every lookup counts against the
 * club's ration.
 */
const inFlight = new Map<string, { at: number; reading: Promise<Conditions | null> }>();
const SHARE_FOR_MS = 10_000;

function readWeather(url: string): Promise<Conditions | null> {
  const now = Date.now();
  const recent = inFlight.get(url);
  if (recent && now - recent.at < SHARE_FOR_MS) return recent.reading;

  const reading = fetch(url).then((response) =>
    response.ok ? (response.json() as Promise<Conditions>) : null,
  );
  inFlight.set(url, { at: now, reading });
  // A failed reading isn't kept: the next try asks again.
  reading.catch(() => inFlight.delete(url));
  return reading;
}

/**
 * Full-width conditions strip across the top of both surfaces.
 *
 * Deliberately one line on a phone: it sits above the scorecard, so every extra
 * row it takes pushes scoring further down the screen. Green speed is not shown
 * — it isn't weather, and it isn't worth a line here.
 */
export function WeatherStrip({
  courseName,
  locationName,
  latitude,
  longitude,
  edge = "px-4 sm:px-8",
  eventToken,
}: WeatherStripProps) {
  const [conditions, setConditions] = useState<Conditions | null>(null);

  useEffect(() => {
    if (latitude === null || longitude === null) return;

    let cancelled = false;

    const load = async () => {
      try {
        const data = await readWeather(
          eventToken
            ? `/api/weather?event=${encodeURIComponent(eventToken)}`
            : `/api/weather?lat=${latitude}&lon=${longitude}`,
        );
        if (data && !cancelled) setConditions(data);
      } catch {
        // Out of signal. Keep whatever reading is already on screen rather
        // than blanking the strip — stale weather beats no weather.
      }
    };

    void load();
    const timer = setInterval(load, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [latitude, longitude, eventToken]);

  const glyph = conditions ? weatherGlyph(conditions.summary) : null;

  return (
    <div
      className={`flex w-full items-center justify-between gap-3 border-b border-hairline bg-forest-deep py-2 text-cream ${edge}`}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-display text-sm font-bold">
          {courseName}
        </span>
        {locationName && (
          <span className="hidden truncate font-mono text-xs text-cream/70 sm:inline">
            {locationName}
          </span>
        )}
      </div>

      {conditions && glyph ? (
        <div
          // Keyed on the reading, so a refresh that changes the weather fades
          // the new values in, and one that doesn't leaves the strip alone.
          key={`${conditions.summary}|${conditions.tempF}|${conditions.windMph}|${conditions.rainChance}`}
          className="flex shrink-0 items-center gap-2.5 font-mono text-xs tabular-nums motion-safe:animate-strip-in sm:gap-4"
        >
          <span
            className={`inline-block text-base leading-none ${MOTION[glyph.motion]}`}
            aria-hidden
          >
            {glyph.icon}
          </span>
          <span className="font-bold">{conditions.tempF}°</span>
          <span>
            {conditions.windMph}
            <span className="text-cream/70">mph </span>
            {conditions.windFrom}
          </span>
          <span>
            <span className="text-cream/70">rain </span>
            {conditions.rainChance}%
          </span>
          <span className="sr-only">{conditions.summary}</span>
        </div>
      ) : (
        // No location, no weather: nothing to say to a golfer about it. The
        // admin is asked for the course's location where they set it up.
        latitude !== null && <span className="shrink-0 font-mono text-xs text-cream/60">…</span>
      )}
    </div>
  );
}
