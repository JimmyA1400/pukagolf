"use client";

import { useMemo, useState } from "react";
import { CoursePicker } from "./CourseSetup";
import { EventShare } from "@/components/EventShare";
import { FORMATS, teamSize, type FormatId } from "@/lib/formats";
import { useClub } from "@/lib/club";
import { createClient } from "@/lib/supabase/client";
import {
  autoAssignTeams,
  movePlayer,
  shuffle,
  type DraftTeam,
} from "@/lib/teams";
import { describePlace, type Place } from "@/lib/weather";

type PickedCourse = {
  courseId: string | null;
  courseName: string;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
};

const today = () => new Date().toISOString().slice(0, 10);

export function EventCreator() {
  const clubId = useClub().club.id;
  const supabase = useMemo(() => createClient(), []);

  const [name, setName] = useState("");
  const [playedOn, setPlayedOn] = useState(today);
  const [format, setFormat] = useState<FormatId>("scramble_4");
  const [course, setCourse] = useState<PickedCourse | null>(null);
  const [players, setPlayers] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [teams, setTeams] = useState<DraftTeam[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminPin, setAdminPin] = useState("");
  const [created, setCreated] = useState<{
    token: string;
    adminPin: string;
    chosen: boolean;
  } | null>(null);

  // Re-draw teams whenever the roster or the format changes. Manual moves are
  // deliberately discarded here: a format change alters team size, so keeping
  // the old arrangement would leave teams the new format cannot accept.
  //
  // Adjusted during render rather than in an effect — React re-runs this
  // component immediately with the new teams, so the page never paints a frame
  // showing an arrangement that belongs to the previous format.
  const drawKey = `${format}:${players.join(" ")}`;
  const [lastDraw, setLastDraw] = useState(drawKey);

  if (drawKey !== lastDraw) {
    setLastDraw(drawKey);
    setTeams(
      autoAssignTeams(
        format,
        players.map((_, i) => String(i)),
      ).teams,
    );
  }

  const assignment = useMemo(
    () =>
      autoAssignTeams(
        format,
        players.map((_, i) => String(i)),
      ),
    [format, players],
  );

  const addPlayers = (text: string) => {
    // One per line, or comma separated — pasting a list is how a 24-person
    // outing actually gets entered.
    const incoming = text
      .split(/[\n,]/)
      .map((n) => n.trim())
      .filter(Boolean);

    if (incoming.length === 0) return;

    setPlayers((current) => {
      const seen = new Set(current.map((n) => n.toLowerCase()));
      const fresh = incoming.filter((n) => !seen.has(n.toLowerCase()));

      return [...current, ...fresh];
    });
    setDraft("");
  };

  const create = async () => {
    setError(null);

    if (!name.trim()) return setError("Give the event a name.");
    if (players.length === 0) return setError("Add at least one player.");
    if (!course) return setError("Pick a course.");

    setBusy(true);

    const { data, error: rpcError } = await supabase.rpc("create_event", {
      payload: {
        name: name.trim(),
        played_on: playedOn,
        format,
        hole_count: 18,
        course_id: course.courseId,
        course_name: course.courseName,
        location_name: course.locationName,
        latitude: course.latitude,
        longitude: course.longitude,
        players,
        // Blank means "generate one"; the database validates anything typed.
        admin_pin: adminPin.trim() || null,
        teams: teams.map((team, i) => ({
          name: team.name,
          position: i,
          members: team.memberIds.map(Number),
        })),
      },
    });

    setBusy(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    const result = data as unknown as {
      share_token: string;
      admin_pin: string;
      pin_was_chosen: boolean;
    };

    setCreated({
      token: result.share_token,
      adminPin: result.admin_pin,
      chosen: result.pin_was_chosen,
    });
  };

  if (created) {
    return (
      <ShareStep
        token={created.token}
        adminPin={created.adminPin}
        pinWasChosen={created.chosen}
        eventName={name}
      />
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-5 sm:p-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          New outing
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          Anyone with the link can score. No accounts needed.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
        >
          {error}
        </p>
      )}

      <Section title="Details">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Event name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Member-Guest, Sunday Skins…"
              className="min-h-12 w-full border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest"
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={playedOn}
              onChange={(e) => setPlayedOn(e.target.value)}
              className="min-h-12 w-full border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest"
            />
          </Field>
        </div>

        <div className="mt-3">
          <Field label="Admin PIN">
            <div className="flex gap-2">
              <input
                value={adminPin}
                onChange={(e) =>
                  setAdminPin(e.target.value.replace(/\D/g, "").slice(0, 8))
                }
                inputMode="numeric"
                autoComplete="off"
                placeholder="8 digits — leave blank to generate one"
                className="min-h-12 min-w-0 flex-1 border border-hairline bg-cream px-3 font-mono text-sm tracking-widest tabular-nums focus:outline-2 focus:outline-forest"
              />
              <button
                type="button"
                onClick={() =>
                  setAdminPin(
                    String(
                      // Browser crypto, not Math.random: this guards the
                      // admin page for the whole day.
                      (crypto.getRandomValues(new Uint32Array(1))[0] %
                        90000000) +
                        10000000,
                    ),
                  )
                }
                className="min-h-12 shrink-0 border border-hairline bg-card px-3 font-mono text-xs tracking-wider uppercase hover:border-forest"
              >
                Generate
              </button>
            </div>
          </Field>
          <p className="mt-1 font-mono text-xs text-ink-soft">
            Unlocks the admin page to fix tee times and scores. Only its hash is
            stored, so it can&apos;t be looked up later.
          </p>
        </div>
      </Section>

      <Section title="Course">
        {course ? (
          <div className="flex items-center justify-between gap-3 border border-hairline bg-card px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-display text-base font-bold">
                {course.courseName}
              </p>
              {course.locationName && (
                <p className="font-mono text-xs text-ink-soft">
                  {course.locationName}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setCourse(null)}
              className="shrink-0 font-mono text-xs text-ink-soft underline"
            >
              Change
            </button>
          </div>
        ) : (
          <CoursePicker
            onPickCourse={async (externalId) => {
              const detail = await (
                await fetch(`/api/courses/${externalId}`)
              ).json();

              // Import the course so the event LINKS to it. Storing only the
              // name would leave the event with no hole data, and the
              // scorecard would silently fall back to par 4 on every hole.
              const { data: courseId, error: importError } = await supabase.rpc(
                "import_course",
                { payload: detail, in_club_id: clubId },
              );

              if (importError) {
                setError(
                  `Could not import that course: ${importError.message}`,
                );
                return;
              }

              setCourse({
                courseId: courseId as unknown as string,
                courseName: detail.name,
                locationName: detail.location_name,
                latitude: detail.latitude,
                longitude: detail.longitude,
              });

              // The source's hole data is community-maintained and sometimes
              // contradicts itself. Say so now, while it can still be fixed.
              setError(detail.parMismatch ?? null);
            }}
            onPickPlace={(place: Place) =>
              setCourse({
                courseId: null,
                courseName: place.name ?? describePlace(place),
                locationName: describePlace(place),
                latitude: place.latitude,
                longitude: place.longitude,
              })
            }
          />
        )}
      </Section>

      <Section title="Format">
        <div className="grid gap-2 sm:grid-cols-2">
          {FORMATS.map((spec) => (
            <button
              key={spec.id}
              type="button"
              onClick={() => setFormat(spec.id)}
              aria-pressed={format === spec.id}
              className={`min-h-16 border px-4 py-3 text-left transition-colors ${
                format === spec.id
                  ? "border-forest bg-forest text-cream"
                  : "border-hairline bg-card hover:border-forest"
              }`}
            >
              <span className="font-display text-base font-bold">
                {spec.label}
              </span>
              <span
                className={`mt-0.5 block font-mono text-xs ${
                  format === spec.id ? "text-cream/80" : "text-ink-soft"
                }`}
              >
                {spec.blurb}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Players" aside={`${players.length} on the roster`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addPlayers(draft);
          }}
          className="flex gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (/[\n,]/.test(text)) {
                e.preventDefault();
                addPlayers(text);
              }
            }}
            placeholder="Add a name, or paste a whole list"
            className="min-h-12 min-w-0 flex-1 border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest"
          />
          <button
            type="submit"
            className="min-h-12 shrink-0 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase"
          >
            Add
          </button>
        </form>

        {players.length > 0 && (
          <ul className="mt-3 divide-y divide-hairline border border-hairline bg-card">
            {players.map((player, i) => (
              <li
                key={`${player}-${i}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <span className="min-w-0 truncate font-display text-[0.95rem]">
                  {player}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPlayers((current) =>
                      current.filter((_, index) => index !== i),
                    )
                  }
                  aria-label={`Remove ${player}`}
                  className="shrink-0 font-mono text-xs text-clay hover:underline"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {players.length > 0 && (
        <Section
          title="Teams"
          aside={
            format === "solo"
              ? "Everyone plays their own ball"
              : `${teamSize(format)} per team`
          }
        >
          {assignment.warning && (
            <p className="mb-3 border border-clay bg-card px-3 py-2 font-mono text-xs text-clay">
              {assignment.warning}
            </p>
          )}

          {format !== "solo" && (
            <>
              <button
                type="button"
                onClick={() =>
                  setTeams(
                    autoAssignTeams(
                      format,
                      shuffle(
                        players.map((_, i) => String(i)),
                        Date.now() % 100000,
                      ),
                    ).teams,
                  )
                }
                className="mb-3 min-h-11 border border-hairline bg-card px-4 font-mono text-xs tracking-wider uppercase hover:border-forest"
              >
                Shuffle teams
              </button>

              <div className="space-y-3">
                {teams.map((team) => (
                  <div
                    key={team.key}
                    className="border border-hairline bg-card"
                  >
                    <p className="border-b border-hairline px-4 py-2 font-display text-sm font-bold">
                      {team.name}
                      <span className="ml-2 font-mono text-xs font-normal text-ink-soft">
                        {team.memberIds.length}/{teamSize(format)}
                      </span>
                    </p>

                    <ul className="divide-y divide-hairline">
                      {team.memberIds.map((memberId) => (
                        <li
                          key={memberId}
                          className="flex items-center justify-between gap-3 px-4 py-2"
                        >
                          <span className="min-w-0 truncate font-display text-[0.95rem]">
                            {players[Number(memberId)]}
                          </span>

                          <label className="shrink-0">
                            <span className="sr-only">
                              Move {players[Number(memberId)]} to another team
                            </span>
                            <select
                              value={team.key}
                              onChange={(e) =>
                                setTeams((current) =>
                                  movePlayer(current, memberId, e.target.value),
                                )
                              }
                              className="min-h-11 border border-hairline bg-cream px-2 font-mono text-xs"
                            >
                              {teams.map((t) => (
                                <option key={t.key} value={t.key}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      )}

      <button
        type="button"
        onClick={create}
        disabled={busy}
        className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
      >
        {busy ? "Creating…" : "Create outing"}
      </button>
    </main>
  );
}

/** The link and QR code, which is the whole point of creating the event. */
function ShareStep({
  token,
  adminPin,
  pinWasChosen,
  eventName,
}: {
  token: string;
  adminPin: string;
  pinWasChosen: boolean;
  eventName: string;
}) {
  return (
    <main className="mx-auto w-full max-w-md space-y-6 p-5 text-center sm:p-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          {eventName} is ready
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          Share this. Anyone who opens it can score.
        </p>
      </div>

      <EventShare token={token} eventName={eventName} />

      <div className="border-2 border-forest bg-card px-4 py-3 text-left">
        <p className="meta">Admin PIN — shown once</p>
        <p className="mt-1 font-display text-3xl font-bold tracking-widest tabular-nums">
          {adminPin}
        </p>
        <p className="mt-2 font-mono text-xs text-ink-soft">
          {pinWasChosen ? "The PIN you chose." : "Write this down."} It unlocks{" "}
          <span className="font-bold">/event/{token.slice(0, 6)}…/admin</span>{" "}
          to fix tee times and scores. Only its hash is stored, so it cannot be
          looked up later.
        </p>
      </div>

      <a
        href={`/event/${token}`}
        className="block min-h-12 border border-hairline bg-card px-4 py-3 font-mono text-xs tracking-wider uppercase hover:border-forest"
      >
        Open it
      </a>
    </main>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="section-head mb-3 flex items-baseline justify-between pb-2">
        <h2 className="text-xl">{title}</h2>
        {aside && <span className="meta">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

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
