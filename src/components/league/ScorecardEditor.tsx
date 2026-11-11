"use client";

import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

export type EditableHole = {
  hole: number;
  par: number;
  strokeIndex: number | null;
  yards: number | null;
};

/**
 * Correct a course's pars and stroke indexes.
 *
 * This exists because the imported data cannot be trusted. The source is
 * community-maintained: some courses come through exactly right, others report
 * hole pars that contradict the course's own stated par by ten strokes. Every
 * to-par figure, every skin and every stroke allocation is computed from these
 * numbers, so the admin needs to be able to put them right.
 */
export function ScorecardEditor({
  courseId,
  holes,
  onSaved,
}: {
  courseId: string;
  holes: readonly EditableHole[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<EditableHole[]>(() => [...holes]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parTotal = draft.reduce((sum, h) => sum + h.par, 0);
  const out = draft.slice(0, 9).reduce((sum, h) => sum + h.par, 0);
  const back = draft.slice(9).reduce((sum, h) => sum + h.par, 0);

  const setPar = (hole: number, par: number) =>
    setDraft((current) =>
      current.map((h) => (h.hole === hole ? { ...h, par } : h)),
    );

  const save = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: saveError } = await supabase.from("course_holes").upsert(
      draft.map((h) => ({
        course_id: courseId,
        hole: h.hole,
        par: h.par,
        handicap_index: h.strokeIndex,
      })),
      { onConflict: "course_id,hole" },
    );

    setBusy(false);

    if (saveError) {
      setError(
        saveError.code === "42501"
          ? "Only an admin can edit the scorecard."
          : saveError.message,
      );
      return;
    }

    onSaved();
  };

  return (
    <div className="mt-3 border-t border-dashed border-hairline pt-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="meta">Pars</span>
        <span className="font-mono text-xs text-ink-soft tabular-nums">
          Out {out} · In {back} · Total{" "}
          <span className="font-bold text-ink">{parTotal}</span>
        </span>
      </div>

      {error && (
        <p role="alert" className="mb-2 font-mono text-xs text-clay">
          {error}
        </p>
      )}

      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-9">
        {draft.map((h) => (
          <label key={h.hole} className="block text-center">
            <span className="block font-mono text-[0.6rem] text-ink-soft">
              {h.hole}
              {h.strokeIndex !== null && (
                <span className="ml-1 opacity-60">si{h.strokeIndex}</span>
              )}
            </span>
            <select
              value={h.par}
              onChange={(e) => setPar(h.hole, Number(e.target.value))}
              aria-label={`Par for hole ${h.hole}`}
              className="mt-0.5 min-h-11 w-full border border-hairline bg-cream text-center font-mono text-sm tabular-nums focus:outline-2 focus:outline-forest"
            >
              {[3, 4, 5, 6].map((par) => (
                <option key={par} value={par}>
                  {par}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="mt-3 min-h-11 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save pars"}
      </button>
    </div>
  );
}
