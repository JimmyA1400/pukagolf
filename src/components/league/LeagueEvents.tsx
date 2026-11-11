"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CoursePicker } from "@/components/league/CourseSetup";
import { formatLabel, getFormat } from "@/lib/formats/registry";
import { createClient } from "@/lib/supabase/client";
import { useClub } from "@/lib/club";

type Row = {
  id: string;
  name: string;
  playedOn: string;
  formatId: string;
  teamSize: number;
  holeCount: number;
  isSimulator: boolean;
  countsForStandings: boolean;
  courseName: string | null;
  players: number;
  in: number;
  teams: number;
  scores: number;
};

type Course = { id: string; name: string; holeCount: number };

/**
 * Events inside the league.
 *
 * Separate from the outings above: an outing is reached by its link and
 * scored by whoever holds it, an event has an invited roster and reaches the
 * players' profiles. Both are the same table and the same format registry —
 * what differs is who can get in.
 */
export function LeagueEvents() {
  const { href, club, league } = useClub();
  const leagueId = league?.id ?? null;
  const clubId = club.id;
  // This club's admins, not admins of somewhere else.
  const isAdmin = club.role === "admin";
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    if (!leagueId) return;

    // The admin controls follow the club role from useClub(): they decide
    // what this component draws, not what it is allowed to do. Every write
    // behind it checks again, which is where the boundary actually is.
    const [list, courseList] = await Promise.all([
      supabase.rpc("league_events", { in_league_id: leagueId }),
      supabase
        .from("courses")
        .select("id, name, hole_count")
        .eq("club_id", clubId)
        .order("name"),
    ]);

    setRows((list.data as unknown as Row[]) ?? []);
    setCourses(
      (courseList.data ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        holeCount: c.hole_count,
      })),
    );
  }, [supabase, leagueId, clubId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <section className="space-y-4">
      <div className="section-head flex flex-wrap items-baseline justify-between gap-2 pb-2">
        <h2 className="text-xl">League events</h2>
        <span className="meta">invited roster · not the share-link kind</span>
      </div>

      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`border bg-card px-4 py-3 font-mono text-xs break-words ${
            notice.ok ? "border-forest text-forest" : "border-clay text-clay"
          }`}
        >
          {notice.text}
        </p>
      )}

      {rows === null ? (
        <p className="font-mono text-xs text-ink-soft">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">
          No league events yet. One is a day inside the league with its own
          roster, format and results — kept out of the season table unless you
          say otherwise.
        </p>
      ) : (
        <ul className="border border-hairline bg-card px-4">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-hairline py-3 last:border-b-0"
            >
              <span className="min-w-0">
                <Link
                  href={href(`/league/events/${row.id}`)}
                  className="font-display text-base font-bold underline"
                >
                  {row.name}
                </Link>
                <span className="block font-mono text-xs text-ink-soft">
                  {row.playedOn}
                  {row.courseName && ` · ${row.courseName}`} ·{" "}
                  {formatLabel(getFormat(row.formatId), row.teamSize)}
                  {row.teamSize > 1 && ` in ${row.teamSize}s`}
                  {row.isSimulator && " · simulator"}
                  {row.countsForStandings && " · counts to the season"}
                </span>
              </span>
              <span className="shrink-0 font-mono text-xs text-ink-soft">
                {row.in}/{row.players} in · {row.teams} sides · {row.scores}{" "}
                scores
              </span>
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <NewLeagueEvent
          courses={courses}
          reload={load}
          onCreated={async (message) => {
            setNotice({ ok: true, text: message });
            await load();
          }}
          onNoted={(message) => setNotice({ ok: true, text: message })}
          onFailed={(message) => setNotice({ ok: false, text: message })}
        />
      )}
    </section>
  );
}

function NewLeagueEvent({
  courses,
  reload,
  onCreated,
  onNoted,
  onFailed,
}: {
  courses: Course[];
  /** Re-reads the course list, so one just imported can be picked. */
  reload: () => Promise<void>;
  onCreated: (message: string) => Promise<void>;
  onNoted: (message: string) => void;
  onFailed: (message: string) => void;
}) {
  const { club, league } = useClub();
  const clubId = club.id;
  const leagueId = league?.id ?? "";
  const supabase = useMemo(() => createClient(), []);
  const [name, setName] = useState("");
  const [playedOn, setPlayedOn] = useState("");
  const [courseId, setCourseId] = useState("");
  const [holes, setHoles] = useState<"18" | "front" | "back">("18");
  const [simulator, setSimulator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);

  const course = courses.find((c) => c.id === courseId);
  const choice = (course?.holeCount ?? 18) >= 18 ? holes : "front";

  // The course search has a form of its own, and a form inside a form is not
  // something HTML allows — the parser throws the inner one away, and its
  // Search button ends up submitting this one. So the panel is the wrapper,
  // the form holds the fields alone, and everything after it reaches the form
  // by name.
  const FORM = "new-league-event";

  return (
    <div className="space-y-3 border border-hairline bg-card p-4">
      <p className="meta">New league event</p>

      <form
        id={FORM}
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return onFailed("Give the event a name.");
          if (!playedOn) return onFailed("Give the event a date.");

          setBusy(true);
          const { error } = await supabase.rpc("owner_create_league_event", {
            in_league_id: leagueId,
            in_name: name.trim(),
            in_played_on: playedOn,
            in_course_id: courseId || null,
            in_hole_count: choice === "18" ? 18 : 9,
            in_start_hole: choice === "back" ? 10 : 1,
            in_is_simulator: simulator,
          });
          setBusy(false);

          if (error) return onFailed(error.message);

          await onCreated(`${name.trim()} created. Invite the players next.`);
          setName("");
          setPlayedOn("");
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Club Championship"
              className={inputClass}
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={playedOn}
              onChange={(e) => setPlayedOn(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Course">
            <select
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              className={inputClass}
            >
              <option value="">Pick a course</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Holes">
            <select
              value={choice}
              onChange={(e) =>
                setHoles(e.target.value as "18" | "front" | "back")
              }
              className={inputClass}
            >
              <option value="18">18 holes</option>
              <option value="front">Front nine (holes 1–9)</option>
              <option value="back">Back nine (holes 10–18)</option>
            </select>
          </Field>
        </div>
      </form>

      {/*
        The same search the outing creator uses, and the same import: picking
        a course brings its pars, stroke indexes and yardages with it. The
        list above is only the courses the league has already played, which is
        every course until someone plays a new one.
      */}
      <div className="border border-hairline bg-cream p-3">
        <p className="meta mb-2">Or find the course being played</p>
        <CoursePicker
          onPickCourse={async (externalId) => {
            setImporting(true);
            try {
              const detail = await (
                await fetch(`/api/courses/${externalId}`)
              ).json();

              // Import it, so the event LINKS to a course with hole data.
              // Keeping only the name would leave the scorecard falling back
              // to par 4 on every hole.
              const { data: imported, error } = await supabase.rpc(
                "import_course",
                {
                  payload: detail,
                  in_club_id: clubId,
                },
              );

              if (error)
                return onFailed(
                  `Could not import that course: ${error.message}`,
                );

              await reload();
              setCourseId(imported as unknown as string);

              // The source's hole data is community-maintained and sometimes
              // contradicts itself. Say so now, while it can still be fixed.
              if (detail.parMismatch) onFailed(detail.parMismatch);
              else
                onNoted(`${detail.name} imported, with its pars and yardages.`);
            } catch {
              onFailed(
                "Could not reach the course search. Try again in a moment.",
              );
            } finally {
              setImporting(false);
            }
          }}
        />
        {importing && (
          <p className="font-mono text-xs text-ink-soft">
            Importing the course…
          </p>
        )}
      </div>

      <label className="flex items-start gap-2 font-mono text-xs">
        <input
          type="checkbox"
          checked={simulator}
          onChange={(e) => setSimulator(e.target.checked)}
          className="mt-0.5 accent-forest"
        />
        <span>
          Simulator round. It still counts, at the league&rsquo;s simulator
          weight, and is labelled everywhere it appears.
        </span>
      </label>

      <button
        type="submit"
        form={FORM}
        disabled={busy}
        className="min-h-12 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
      >
        {busy ? "Creating…" : "Create the event"}
      </button>
    </div>
  );
}

const inputClass =
  "min-h-11 w-full border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="meta mb-1 block">{label}</span>
      {children}
    </label>
  );
}
