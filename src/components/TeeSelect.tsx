"use client";

import { useState } from "react";

import { defaultTee, type TeeOption } from "@/lib/yardage";

/**
 * Remembers the chosen tee for the session.
 *
 * sessionStorage rather than localStorage: a tee choice belongs to today's
 * round, not forever. Keyed per course so two outings on different courses
 * don't fight over one value.
 */
const storageKey = (scope: string) => `golf.tee.${scope}`;

function readStored(scope: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(scope));
  } catch {
    // Private browsing or blocked storage: fall back to the default each time.
    return null;
  }
}

function writeStored(scope: string, tee: string): void {
  try {
    sessionStorage.setItem(storageKey(scope), tee);
  } catch {
    // Not remembering is survivable.
  }
}

/**
 * The selected tee, defaulting to the longest unless the player saved one.
 *
 * `scope` should identify the course, so moving between holes — or between the
 * scorecard and any other view of the same course — keeps the selection.
 */
export function useTeeSelection(
  scope: string,
  options: readonly TeeOption[],
  preferred?: string | null,
) {
  const resolve = () => {
    const stored = readStored(scope);
    const valid =
      stored && options.some((o) => o.tee === stored) ? stored : null;

    return valid ?? defaultTee(options, preferred);
  };

  const [tee, setTee] = useState<string | null>(resolve);

  // Options arrive after the course loads, and a stored tee may only become
  // valid then. Adjusted during render rather than in an effect, so the card
  // never paints a frame against the wrong tee.
  const key = options.map((o) => o.tee).join(",");
  const [lastKey, setLastKey] = useState(key);

  if (key !== lastKey) {
    setLastKey(key);
    setTee(resolve());
  }

  const choose = (next: string) => {
    writeStored(scope, next);
    setTee(next);
  };

  return [tee, choose] as const;
}

/**
 * One dropdown listing every tee, longest first, with its rating and slope.
 *
 * A select rather than a row of buttons: a course can carry six or more sets,
 * and on a phone that row wraps into something unreadable.
 */
export function TeeSelect({
  options,
  value,
  onChange,
  id = "tee-select",
}: {
  options: readonly TeeOption[];
  value: string | null;
  onChange: (tee: string) => void;
  id?: string;
}) {
  if (options.length === 0) return null;

  const selected = options.find((o) => o.tee === value) ?? options[0];

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <label htmlFor={id} className="meta">
        Tees
      </label>

      <select
        id={id}
        value={selected.tee}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 border border-hairline bg-cream px-2 font-mono text-sm focus:outline-2 focus:outline-forest"
      >
        {options.map((option) => (
          <option key={option.tee} value={option.tee}>
            {option.label}
            {option.totalYards > 0 ? ` — ${option.totalYards} yds` : ""}
          </option>
        ))}
      </select>

      {(selected.courseRating !== null || selected.slope !== null) && (
        <span className="font-mono text-xs text-ink-soft tabular-nums">
          {selected.courseRating !== null && `${selected.courseRating} rating`}
          {selected.courseRating !== null && selected.slope !== null && " · "}
          {selected.slope !== null && `${selected.slope} slope`}
        </span>
      )}
    </div>
  );
}
