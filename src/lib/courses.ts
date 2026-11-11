/**
 * Course data from OpenGolfAPI.
 *
 * Free reads, no API key. The data is ODbL-licensed, so `attribution` comes
 * back with every import and must be shown wherever the data is displayed.
 *
 * Only the read endpoints are used. Their documentation asks integrators to
 * adopt an identity system and contribute player data back; that is a decision
 * for the league to make deliberately, not a default, so nothing is ever sent.
 */

import { filterTees, filterYardages, isRecognisedTee } from "./tees";

const BASE = "https://api.opengolfapi.org/api/v1";

export const ATTRIBUTION =
  "© OpenStreetMap contributors (ODbL 1.0) via OpenGolfAPI";

export type CourseSearchResult = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  par: number | null;
  type: string | null;
};

export type HoleData = {
  hole: number;
  par: number;
  /** Stroke index, 1 = hardest. Null when the course hasn't been rated. */
  handicap_index: number | null;
  /** Yardage keyed by tee colour, e.g. { blue: 371 }. */
  yardages: Record<string, number>;
};

export type TeeSet = {
  tee_key: string;
  tee_name: string;
  tee_color: string | null;
  gender: string | null;
  course_rating: number | null;
  slope: number | null;
  par: number | null;
  yardage: number | null;
};

export type ImportedCourse = {
  external_id: string;
  name: string;
  hole_count: number;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  location_name: string | null;
  city: string | null;
  state: string | null;
  attribution: string;
  holes: HoleData[];
  tees: TeeSet[];
  /**
   * The course's par as the source states it, which is not always the sum of
   * its own hole data — see `parMismatch`.
   */
  statedPar: number | null;
  /**
   * Set when the hole pars don't add up to the stated par.
   *
   * The source is community-maintained and its hole-level data ranges from
   * exact to nonsense: one real course reports twelve consecutive par 5s and a
   * total of 80 against a stated par of 69. Scoring against that would make
   * every to-par figure wrong, so a mismatch is surfaced for the admin to
   * correct rather than silently trusted.
   */
  parMismatch: string | null;
  /**
   * Tee names discarded on import because they aren't tee vocabulary.
   *
   * Real courses in the source publish sets called things like "web", which
   * would otherwise appear as a selectable tee on the scorecard.
   */
  droppedTees: string[];
};

export function searchUrl(query: string, state?: string): string {
  const params = new URLSearchParams({ q: query });
  if (state) params.set("state", state);

  return `${BASE}/courses/search?${params}`;
}

export function courseUrl(id: string): string {
  return `${BASE}/courses/${encodeURIComponent(id)}`;
}

type RawSearch = {
  courses?: {
    id: string;
    name?: string;
    course_name?: string;
    city?: string;
    state?: string;
    par?: number;
    type?: string;
  }[];
};

export function toSearchResults(data: RawSearch): CourseSearchResult[] {
  return (data.courses ?? []).map((c) => ({
    id: c.id,
    name: c.name ?? c.course_name ?? "Unnamed course",
    city: c.city ?? null,
    state: c.state ?? null,
    par: c.par ?? null,
    type: c.type ?? null,
  }));
}

type RawCourse = {
  id: string;
  course_name?: string;
  club_name?: string;
  holes?: number;
  par?: number;
  lat?: number;
  lng?: number;
  timezone?: string;
  city?: string;
  state?: string;
  holes_data?: {
    number: number;
    par: number;
    handicap_index?: number | null;
    yardages?: Record<string, number | null> | null;
  }[];
  tees?: {
    tee_key: string;
    tee_name?: string;
    tee_color?: string;
    gender?: string;
    course_rating?: number;
    slope?: number;
    par?: number;
    yardage?: number;
  }[];
};

export function toImportedCourse(data: RawCourse): ImportedCourse {
  const holes = (data.holes_data ?? [])
    .map((h) => ({
      hole: h.number,
      par: h.par,
      handicap_index: h.handicap_index ?? null,
      // Two filters. Null yardages go because a missing number and a null mean
      // the same thing; unrecognised tee names go because the source publishes
      // sets like "web" that would otherwise be selectable on the scorecard.
      yardages: filterYardages(
        Object.fromEntries(
          Object.entries(h.yardages ?? {}).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        ),
      ),
    }))
    .sort((a, b) => a.hole - b.hole);

  // Collected across every hole and the tee list, so the import can report
  // exactly what it threw away rather than discarding it silently.
  const droppedFromHoles = new Set<string>();
  for (const hole of data.holes_data ?? []) {
    for (const [tee, yards] of Object.entries(hole.yardages ?? {})) {
      if (typeof yards === "number" && !isRecognisedTee(tee)) {
        droppedFromHoles.add(tee);
      }
    }
  }

  const teeSets = filterTees(data.tees ?? [], (t) => t.tee_name ?? t.tee_key);
  for (const name of teeSets.dropped) droppedFromHoles.add(name);

  const city = data.city ?? null;
  const state = data.state ?? null;
  const statedPar = data.par ?? null;
  const holeParTotal = holes.reduce((sum, h) => sum + h.par, 0);

  return {
    statedPar,
    parMismatch:
      holes.length > 0 && statedPar !== null && holeParTotal !== statedPar
        ? `Hole pars add up to ${holeParTotal}, but this course is listed as par ${statedPar}. ` +
          `The hole data may be wrong — check it before scoring.`
        : null,
    external_id: data.id,
    name: data.course_name ?? data.club_name ?? "Unnamed course",
    // Trust the hole rows over the summary field; the rows are what we render.
    hole_count: holes.length || data.holes || 18,
    latitude: data.lat ?? null,
    longitude: data.lng ?? null,
    timezone: data.timezone ?? null,
    location_name: [city, state].filter(Boolean).join(", ") || null,
    city,
    state,
    attribution: ATTRIBUTION,
    holes,
    tees: teeSets.kept.map((t) => ({
      tee_key: t.tee_key,
      tee_name: t.tee_name ?? t.tee_key,
      tee_color: t.tee_color ?? null,
      gender: t.gender ?? null,
      course_rating: t.course_rating ?? null,
      slope: t.slope ?? null,
      par: t.par ?? null,
      yardage: t.yardage ?? null,
    })),
    droppedTees: [...droppedFromHoles].sort(),
  };
}

/** Tee colours present in the hole data, in the order the tees are listed. */
export function teeColumns(course: ImportedCourse): string[] {
  const fromHoles = new Set(
    course.holes.flatMap((h) => Object.keys(h.yardages)),
  );
  const ordered = course.tees
    .map((t) => t.tee_color ?? t.tee_key)
    .filter((colour) => fromHoles.has(colour));

  // Anything present on the holes but missing from the tee list still counts.
  for (const colour of fromHoles) {
    if (!ordered.includes(colour)) ordered.push(colour);
  }

  return ordered;
}

/** Front nine, back nine and total yardage for one tee. */
export function yardageTotals(
  course: ImportedCourse,
  teeColour: string,
): { out: number; in: number; total: number } {
  const yards = (hole: HoleData) => hole.yardages[teeColour] ?? 0;
  const out = course.holes.slice(0, 9).reduce((s, h) => s + yards(h), 0);
  const back = course.holes.slice(9).reduce((s, h) => s + yards(h), 0);

  return { out, in: back, total: out + back };
}
