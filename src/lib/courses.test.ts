import { describe, expect, it } from "vitest";

import {
  ATTRIBUTION,
  courseUrl,
  searchUrl,
  teeColumns,
  toImportedCourse,
  toSearchResults,
  yardageTotals,
} from "./courses";

/** Trimmed from a real OpenGolfAPI response. */
const RAW_COURSE = {
  id: "ff90eb8a-d9c6-4d6d-94f1-2862b2c0ac43",
  course_name: "Auburn Hills Golf Course",
  club_name: "Auburn Hills",
  holes: 18,
  par: 72,
  lat: 37.6740167,
  lng: -97.4989223,
  timezone: "America/Chicago",
  city: "Wichita",
  state: "KS",
  holes_data: [
    {
      number: 1,
      par: 4,
      handicap_index: 3,
      yardages: { red: 304, blue: 371, white: 345 },
    },
    {
      number: 2,
      par: 4,
      handicap_index: 15,
      yardages: { red: 310, blue: 420, white: 360 },
    },
  ],
  tees: [
    {
      tee_key: "blue-male",
      tee_name: "Blue",
      tee_color: "blue",
      gender: "Male",
      course_rating: 71.2,
      slope: 128,
      par: 72,
      yardage: 6500,
    },
    {
      tee_key: "white-male",
      tee_name: "White",
      tee_color: "white",
      gender: "Male",
      course_rating: 69.1,
      slope: 121,
      par: 72,
      yardage: 6100,
    },
  ],
};

describe("toSearchResults", () => {
  it("prefers name and falls back to course_name", () => {
    const results = toSearchResults({
      courses: [
        { id: "a", name: "Pinehurst No. 2", city: "Pinehurst", state: "NC" },
        { id: "b", course_name: "Fallback Links" },
      ],
    });

    expect(results[0].name).toBe("Pinehurst No. 2");
    expect(results[1].name).toBe("Fallback Links");
  });

  it("returns an empty list when nothing matched", () => {
    expect(toSearchResults({})).toEqual([]);
  });

  it("normalises missing city and state to null", () => {
    const [only] = toSearchResults({ courses: [{ id: "b" }] });

    expect(only.city).toBeNull();
    expect(only.state).toBeNull();
  });
});

describe("toImportedCourse", () => {
  const course = toImportedCourse(RAW_COURSE);

  it("keeps the coordinates that drive the weather panel", () => {
    expect(course.latitude).toBe(37.6740167);
    expect(course.longitude).toBe(-97.4989223);
    expect(course.timezone).toBe("America/Chicago");
  });

  it("carries the stroke index for each hole", () => {
    expect(course.holes[0].handicap_index).toBe(3);
    expect(course.holes[1].handicap_index).toBe(15);
  });

  it("carries yardages per tee colour", () => {
    expect(course.holes[0].yardages).toEqual({
      red: 304,
      blue: 371,
      white: 345,
    });
  });

  it("keeps course rating and slope, which belong to the tee not the course", () => {
    expect(course.tees[0]).toMatchObject({
      tee_name: "Blue",
      course_rating: 71.2,
      slope: 128,
    });
  });

  it("builds a location label from city and state", () => {
    expect(course.location_name).toBe("Wichita, KS");
  });

  it("attaches the licence attribution", () => {
    expect(course.attribution).toBe(ATTRIBUTION);
  });

  it("keeps the stated par alongside the hole data", () => {
    expect(course.statedPar).toBe(72);
  });

  it("stays quiet when hole pars add up to the stated par", () => {
    const consistent = toImportedCourse({
      ...RAW_COURSE,
      par: 8,
      holes_data: [
        { number: 1, par: 4, handicap_index: 1, yardages: {} },
        { number: 2, par: 4, handicap_index: 2, yardages: {} },
      ],
    });

    expect(consistent.parMismatch).toBeNull();
  });

  it("flags hole pars that contradict the stated par", () => {
    // A real course in the source reports twelve par 5s and a total of 80
    // against a stated par of 69. Scoring against that makes every to-par
    // figure wrong, so it must not pass silently.
    const broken = toImportedCourse({
      ...RAW_COURSE,
      par: 69,
      holes_data: [
        { number: 1, par: 5, handicap_index: 1, yardages: {} },
        { number: 2, par: 5, handicap_index: 2, yardages: {} },
      ],
    });

    expect(broken.parMismatch).toMatch(/add up to 10.*listed as par 69/);
  });

  it("does not flag a course that has no hole data at all", () => {
    const bare = toImportedCourse({ id: "x", course_name: "Bare", par: 72 });

    expect(bare.parMismatch).toBeNull();
  });

  it("counts holes from the rows it will actually render", () => {
    // The summary says 18 but only two rows came back; the rows win, because
    // rendering eighteen columns with sixteen blanks would be a lie.
    expect(course.hole_count).toBe(2);
  });

  it("sorts holes even when the API returns them out of order", () => {
    const shuffled = {
      ...RAW_COURSE,
      holes_data: [...RAW_COURSE.holes_data].reverse(),
    };

    expect(toImportedCourse(shuffled).holes.map((h) => h.hole)).toEqual([1, 2]);
  });

  it("drops null yardages rather than storing them", () => {
    const withNulls = {
      ...RAW_COURSE,
      holes_data: [
        { number: 1, par: 4, handicap_index: 3, yardages: { red: null, blue: 371 } },
      ],
    };

    expect(toImportedCourse(withNulls).holes[0].yardages).toEqual({ blue: 371 });
  });

  it("survives a course with no hole or tee data at all", () => {
    const bare = toImportedCourse({ id: "x", course_name: "Bare" });

    expect(bare.holes).toEqual([]);
    expect(bare.tees).toEqual([]);
    expect(bare.hole_count).toBe(18);
  });
});

describe("teeColumns", () => {
  it("orders colours by the tee list", () => {
    expect(teeColumns(toImportedCourse(RAW_COURSE))).toEqual([
      "blue",
      "white",
      "red",
    ]);
  });

  it("includes a colour on the holes that the tee list omits", () => {
    // "red" has yardages but no tee row; dropping it would lose a column.
    const course = toImportedCourse(RAW_COURSE);

    expect(teeColumns(course)).toContain("red");
  });
});

describe("yardageTotals", () => {
  it("splits at the turn and totals the round", () => {
    const course = toImportedCourse(RAW_COURSE);

    expect(yardageTotals(course, "blue")).toEqual({
      out: 791,
      in: 0,
      total: 791,
    });
  });

  it("treats a tee with no yardage on a hole as zero, not NaN", () => {
    const course = toImportedCourse(RAW_COURSE);

    expect(yardageTotals(course, "gold").total).toBe(0);
  });
});

describe("urls", () => {
  it("escapes the search query", () => {
    expect(searchUrl("Pebble Beach & Co")).toContain("q=Pebble+Beach+%26+Co");
  });

  it("adds a state filter only when given", () => {
    expect(searchUrl("Pine", "MI")).toContain("state=MI");
    expect(searchUrl("Pine")).not.toContain("state=");
  });

  it("escapes the course id", () => {
    expect(courseUrl("a/b")).toContain("a%2Fb");
  });
});
