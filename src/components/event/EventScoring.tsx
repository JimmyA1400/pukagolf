"use client";

import { useMemo, useState } from "react";

import Link from "next/link";

import { EventShare } from "@/components/EventShare";
import { WeatherStrip } from "@/components/WeatherStrip";
import { Tabs } from "@/components/league/Tabs";
import {
  EventScorecardGrid,
  EventSkins,
  EventTeeSheet,
  EventWhosWhere,
} from "./EventPanels";
import { formatToPar } from "@/lib/leaderboard";
import {
  buildTeamStandings,
  getFormat,
  teamHoles,
  type Entry,
} from "@/lib/formats";
import {
  readIdentity,
  useEvent,
  writeIdentity,
  type EventState,
} from "@/lib/useEvent";

export function EventScoring({ token }: { token: string }) {
  const { state, submit } = useEvent(token);
  const [playerId, setPlayerId] = useState<string | null>(() =>
    readIdentity(token),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  if (state.status === "loading") {
    return <Centered>Loading the event…</Centered>;
  }

  if (state.status === "error") {
    return <Centered>{state.message}</Centered>;
  }

  const { data } = state;
  const me = data.players.find((p) => p.id === playerId) ?? null;

  const pick = (id: string | null) => {
    writeIdentity(token, id);
    setPlayerId(id);
    setNotice(null);
  };

  return (
    <div className="min-w-0">
      <WeatherStrip
        courseName={data.event.course_name ?? "Course"}
        locationName={data.event.location_name}
        latitude={data.event.latitude}
        longitude={data.event.longitude}
        eventToken={token}
      />

      <header className="border-b-4 border-rule bg-cream px-4 py-4 sm:px-8">
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          {data.event.name}
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          {getFormat(data.event.format).label} · {data.event.hole_count} holes
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
          <span className="meta">
            {me ? `Scoring as ${me.name}` : "Pick your name to score"}
          </span>

          <div className="flex items-center gap-4">
            {me && (
              <button
                type="button"
                onClick={() => pick(null)}
                className="font-mono text-xs text-ink-soft underline"
              >
                Not you? Switch player
              </button>
            )}
            <button
              type="button"
              onClick={() => setSharing(!sharing)}
              aria-expanded={sharing}
              aria-controls="event-invite"
              className="font-mono text-xs text-forest underline"
            >
              {sharing ? "Hide invite" : "Invite"}
            </button>

            <Link
              href={`/event/${token}/admin`}
              className="font-mono text-xs text-forest underline"
            >
              Admin
            </Link>
          </div>
        </div>

        <div id="event-invite" hidden={!sharing} className="pt-4">
          <p className="meta mb-2">Anyone who opens this can score</p>
          <EventShare
            token={token}
            eventName={data.event.name}
            className="mx-auto max-w-xs"
          />
        </div>
      </header>

      <main className="min-w-0 space-y-8 bg-sand px-4 py-6 sm:px-8">
        {notice && (
          <p
            role="alert"
            className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
          >
            {notice}
          </p>
        )}

        {me ? (
          <ScoreEntryCard
            data={data}
            meId={me.id}
            onSubmit={async (teamId, forPlayer, hole, strokes) => {
              setNotice(
                await submit(teamId, forPlayer, hole, strokes, me.name),
              );
            }}
          />
        ) : (
          <PlayerPicker data={data} onPick={pick} />
        )}

        <EventLeaderboard data={data} meId={me?.id ?? null} />

        <Tabs
          tabs={[
            {
              id: "scorecard",
              label: "Scorecard",
              content: <EventScorecardGrid data={data} />,
            },
            {
              id: "nineteenth-hole",
              label: "19th Hole",
              content: (
                <div className="space-y-4">
                  <section className="min-w-0">
                    <div className="section-head mb-3 flex items-baseline justify-between pb-2">
                      <h2 className="text-xl">Who&apos;s where</h2>
                      <span className="meta">
                        {data.event.hole_count} holes
                      </span>
                    </div>
                    <EventWhosWhere data={data} />
                  </section>

                  <EventTeeSheet data={data} />

                  {data.event.skins_enabled && (
                    <EventSkins data={data} stake={data.event.skins_stake} />
                  )}
                </div>
              ),
            },
          ]}
        />
      </main>
    </div>
  );
}

/** First thing a player sees: a big list of names, nothing else to fill in. */
function PlayerPicker({
  data,
  onPick,
}: {
  data: EventState;
  onPick: (id: string) => void;
}) {
  return (
    <section>
      <h2 className="section-head mb-3 pb-2 text-xl">Who are you?</h2>
      <p className="mb-4 font-mono text-xs text-ink-soft">
        Tap your name. This device will remember it.
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {data.players.map((player) => (
          <button
            key={player.id}
            type="button"
            onClick={() => onPick(player.id)}
            className="min-h-14 border border-hairline bg-card px-3 py-3 text-left font-display text-base font-semibold transition-colors hover:border-forest active:bg-highlight"
          >
            {player.name}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * The scoring surface: one hole at a time, with tap targets big enough to hit
 * while holding a phone in one hand.
 */
function ScoreEntryCard({
  data,
  meId,
  onSubmit,
}: {
  data: EventState;
  meId: string;
  onSubmit: (
    teamId: string,
    playerId: string | null,
    hole: number,
    strokes: number,
  ) => void;
}) {
  const spec = getFormat(data.event.format);
  const team = data.teams.find((t) => t.memberIds.includes(meId));

  const parByHole = useMemo(
    () => Object.fromEntries(data.holes.map((h) => [h.hole, h.par])),
    [data.holes],
  );

  const holes = useMemo(
    () =>
      team
        ? teamHoles(
            data.event.format,
            data.scores,
            team.id,
            team.memberIds,
            data.event.hole_count,
          )
        : [],
    [team, data],
  );

  // In a scramble the team posts once; otherwise this is my own card.
  const mine = data.scores.filter((s) =>
    spec.entry === "team"
      ? s.teamId === team?.id && s.playerId === null
      : s.playerId === meId,
  );

  const firstEmpty =
    Array.from({ length: data.event.hole_count }, (_, i) => i + 1).find(
      (hole) => !mine.some((s) => s.hole === hole),
    ) ?? data.event.hole_count;

  const [hole, setHole] = useState(firstEmpty);

  if (!team) {
    return (
      <p className="border border-hairline bg-card px-4 py-3 font-mono text-xs text-ink-soft">
        You&apos;re not on a team yet. Ask the organiser to add you.
      </p>
    );
  }

  // Null when the course has no hole data. Kept distinct from a real par so
  // the card says "par unknown" instead of quietly claiming every hole is a 4.
  const par: number | null = parByHole[hole] ?? null;
  const existing = mine.find((s) => s.hole === hole)?.strokes ?? null;
  const teamScore = holes.find((h) => h.hole === hole);

  // Centred on par: the scores a golfer actually posts. With no par data, fall
  // back to a plain 2-8 spread rather than pretending the hole is a par 4.
  const options = (
    par === null
      ? [2, 3, 4, 5, 6, 7, 8]
      : [par - 2, par - 1, par, par + 1, par + 2, par + 3, par + 4]
  ).filter((n) => n >= 1 && n <= 20);

  return (
    <section>
      <div className="section-head mb-3 flex items-baseline justify-between pb-2">
        <h2 className="text-xl">
          {spec.entry === "team" ? team.name ?? "Your team" : "Your card"}
        </h2>
        <span className="meta">
          {spec.entry === "team" ? "One score for the team" : "Your own ball"}
        </span>
      </div>

      <div className="border border-hairline bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setHole((h) => Math.max(1, h - 1))}
            disabled={hole === 1}
            aria-label="Previous hole"
            className="min-h-12 min-w-12 border border-hairline font-mono text-lg disabled:opacity-30"
          >
            ‹
          </button>

          <div className="text-center">
            <div className="font-display text-3xl font-bold">Hole {hole}</div>
            <div className="meta mt-0.5">
              {par === null ? "Par not set" : `Par ${par}`}
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              setHole((h) => Math.min(data.event.hole_count, h + 1))
            }
            disabled={hole === data.event.hole_count}
            aria-label="Next hole"
            className="min-h-12 min-w-12 border border-hairline font-mono text-lg disabled:opacity-30"
          >
            ›
          </button>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-7">
          {options.map((strokes) => (
            <button
              key={strokes}
              type="button"
              onClick={() => {
                onSubmit(
                  team.id,
                  spec.entry === "team" ? null : meId,
                  hole,
                  strokes,
                );
                if (hole < data.event.hole_count) setHole(hole + 1);
              }}
              className={`min-h-16 border font-display text-2xl font-bold transition-colors active:bg-forest active:text-cream ${
                existing === strokes
                  ? "border-forest bg-forest text-cream"
                  : "border-hairline bg-cream hover:border-forest"
              }`}
            >
              {strokes}
            </button>
          ))}
        </div>

        {existing !== null && (
          <p className="mt-3 text-center font-mono text-xs text-ink-soft">
            Saved {existing} on hole {hole}. Tap another number to change it.
          </p>
        )}

        {spec.kind === "best_ball" && teamScore && (
          <p className="mt-3 border-t border-dashed border-hairline pt-2 text-center font-mono text-xs text-ink-soft">
            {teamScore.strokes !== null
              ? `Team score ${teamScore.strokes}`
              : `Waiting on ${team.memberIds.length - teamScore.posted} more card${
                  team.memberIds.length - teamScore.posted === 1 ? "" : "s"
                }`}
          </p>
        )}
      </div>
    </section>
  );
}

function EventLeaderboard({
  data,
  meId,
}: {
  data: EventState;
  meId: string | null;
}) {
  const pars = Object.fromEntries(data.holes.map((h) => [h.hole, h.par]));
  const hasPars = data.holes.length > 0;

  const standings = buildTeamStandings(
    data.event.format,
    data.scores as Entry[],
    data.teams.map((t) => ({ id: t.id, memberIds: t.memberIds })),
    data.event.hole_count,
    hasPars ? pars : undefined,
  );

  const nameOf = (teamId: string) => {
    const team = data.teams.find((t) => t.id === teamId);
    if (!team) return teamId;

    const names = team.memberIds
      .map((id) => data.players.find((p) => p.id === id)?.name)
      .filter(Boolean)
      .join(", ");

    return team.name ? `${team.name} — ${names}` : names;
  };

  const myTeamId = data.teams.find((t) =>
    meId ? t.memberIds.includes(meId) : false,
  )?.id;

  return (
    <section>
      <h2 className="section-head mb-3 pb-2 text-xl">Leaderboard</h2>

      <div className="space-y-2">
        {standings.map((entry) => (
          <div
            key={entry.teamId}
            className={`flex items-center gap-3 border border-hairline px-4 py-3 ${
              entry.teamId === myTeamId ? "bg-highlight" : "bg-card"
            }`}
          >
            <span className="w-6 shrink-0 font-mono text-sm text-ink-soft">
              {entry.position}
            </span>
            <span className="min-w-0 flex-1 truncate font-display text-[0.95rem] font-semibold">
              {nameOf(entry.teamId)}
            </span>
            <span
              className={`w-12 shrink-0 text-right font-mono text-sm font-bold tabular-nums ${
                entry.toPar !== null && entry.toPar < 0 ? "text-clay" : ""
              }`}
            >
              {entry.thru === 0
                ? "—"
                : (formatToPar(entry.toPar) ?? entry.strokes)}
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-xs text-ink-soft">
              {entry.thru >= data.event.hole_count
                ? "F"
                : `thru ${entry.thru}`}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}
