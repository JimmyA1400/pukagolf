"use client";

import { useState } from "react";

import { Panel } from "./Panels";
import { ScorecardEditor, type EditableHole } from "./ScorecardEditor";
import type { CourseSearchResult } from "@/lib/courses";
import { describePlace, type Place } from "@/lib/weather";

/**
 * Which course is being played.
 *
 * Deliberately no conditions readout: the weather strip at the top of the page
 * owns that now, and showing it twice just pushed the scorecard down.
 */
export function CourseSetup({
  courseName,
  locationName,
  attribution,
  courseId,
  holes,
  onCourseChange,
  onLocationChange,
  onHolesSaved,
  isAdmin,
}: {
  courseName: string;
  locationName: string | null;
  attribution: string | null;
  courseId?: string | null;
  holes?: readonly EditableHole[];
  onCourseChange?: (externalId: string) => void;
  onLocationChange: (place: Place) => void;
  onHolesSaved?: () => void;
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editingPars, setEditingPars] = useState(false);

  const parTotal = (holes ?? []).reduce((sum, h) => sum + h.par, 0);

  return (
    <Panel
      icon="🗺"
      title="Course"
      subtitle={locationName ?? "Location not set"}
      right={
        isAdmin && (
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            className="shrink-0 font-mono text-xs text-ink-soft underline"
          >
            {editing ? "Cancel" : "Change"}
          </button>
        )
      }
    >
      {editing && (
        <CoursePicker
          onPickCourse={
            onCourseChange &&
            ((externalId) => {
              onCourseChange(externalId);
              setEditing(false);
            })
          }
          onPickPlace={(place) => {
            onLocationChange(place);
            setEditing(false);
          }}
        />
      )}

      <p className="font-display text-lg font-bold">
        {courseName}
        {parTotal > 0 && (
          <span className="ml-2 font-mono text-xs font-normal text-ink-soft">
            par {parTotal}
          </span>
        )}
      </p>

      {isAdmin && courseId && (holes?.length ?? 0) > 0 && (
        <button
          type="button"
          onClick={() => setEditingPars((open) => !open)}
          className="mt-2 font-mono text-xs text-ink-soft underline"
        >
          {editingPars ? "Done editing pars" : "Pars wrong? Edit the scorecard"}
        </button>
      )}

      {editingPars && courseId && holes && (
        <ScorecardEditor
          courseId={courseId}
          holes={holes}
          onSaved={() => {
            setEditingPars(false);
            onHolesSaved?.();
          }}
        />
      )}

      {attribution && (
        <p className="mt-3 border-t border-dashed border-hairline pt-2 font-mono text-[0.65rem] text-ink-soft">
          Course data {attribution}
        </p>
      )}
    </Panel>
  );
}

/**
 * Search a real course by name, or fall back to naming a town.
 *
 * Picking a course brings pars, stroke indexes, yardages and coordinates in one
 * go. The town fallback exists for courses missing from the database: it gets
 * the weather right and leaves the scorecard alone.
 *
 * Both halves are optional, because not every caller has somewhere to put
 * both answers. A league event is stored as a course and nothing else, so it
 * asks for the course search alone and never offers the town — an offer it
 * could not honour is worse than not making it.
 */
export function CoursePicker({
  onPickCourse,
  onPickPlace,
}: {
  onPickCourse?: (externalId: string) => void;
  onPickPlace?: (place: Place) => void;
}) {
  const [mode, setMode] = useState<"course" | "town">(
    onPickCourse ? "course" : "town",
  );
  const [query, setQuery] = useState("");
  const [courses, setCourses] = useState<CourseSearchResult[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    try {
      const endpoint =
        mode === "course"
          ? `/api/courses/search?q=${encodeURIComponent(query)}`
          : `/api/geocode?q=${encodeURIComponent(query)}`;
      const data = await (await fetch(endpoint)).json();

      setCourses(data.courses ?? []);
      setPlaces(data.places ?? []);
    } catch {
      setCourses([]);
      setPlaces([]);
    }
    setSearching(false);
    setSearched(true);
  };

  const results = mode === "course" ? courses : places;

  return (
    <div className="mb-3 border-b border-dashed border-hairline pb-3">
      <form onSubmit={search} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            mode === "course" ? "Course name…" : "Town or city near the course…"
          }
          aria-label={
            mode === "course" ? "Search for a course" : "Search for a town"
          }
          className="min-w-0 flex-1 border border-hairline bg-cream px-3 py-2 font-mono text-xs focus:outline-2 focus:outline-forest"
        />
        <button
          type="submit"
          className="min-h-11 shrink-0 bg-forest-deep px-3 font-mono text-xs tracking-wider text-cream uppercase"
        >
          {searching ? "…" : "Search"}
        </button>
      </form>

      {mode === "course" &&
        courses.map((course) => (
          <button
            key={course.id}
            type="button"
            onClick={() => onPickCourse?.(course.id)}
            className="mt-1.5 block min-h-11 w-full text-left font-display text-[0.95rem] hover:underline"
          >
            {course.name}
            <span className="ml-2 font-mono text-xs text-ink-soft">
              {[course.city, course.state].filter(Boolean).join(", ")}
              {course.par ? ` · par ${course.par}` : ""}
            </span>
          </button>
        ))}

      {mode === "town" &&
        places.map((place) => (
          <button
            key={`${place.latitude},${place.longitude}`}
            type="button"
            onClick={() => onPickPlace?.(place)}
            className="mt-1.5 block min-h-11 w-full text-left font-display text-[0.95rem] hover:underline"
          >
            {describePlace(place)}
          </button>
        ))}

      {searched && !searching && results.length === 0 && (
        <p className="mt-2 font-mono text-xs text-ink-soft">Nothing found.</p>
      )}

      {onPickCourse && onPickPlace && (
        <button
          type="button"
          onClick={() => {
            setMode(mode === "course" ? "town" : "course");
            setCourses([]);
            setPlaces([]);
            setSearched(false);
          }}
          className="mt-2 font-mono text-xs text-ink-soft underline"
        >
          {mode === "course"
            ? "Course not listed? Set the location by town"
            : "Search for a course instead"}
        </button>
      )}
    </div>
  );
}
