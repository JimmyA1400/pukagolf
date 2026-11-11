"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EventShare } from "@/components/EventShare";
import { getFormat, type FormatId } from "@/lib/formats";
import {
  canDeleteEvent,
  deleteRefusal,
  eventStatus,
  type EventStatus,
} from "@/lib/event-status";
import { pinProblem } from "@/lib/event-pin";
import { createClient } from "@/lib/supabase/client";
import { useClub } from "@/lib/club";

type AdminEvent = {
  id: string;
  name: string;
  playedOn: string;
  format: FormatId;
  holeCount: number;
  courseName: string | null;
  shareToken: string;
  completedAt: string | null;
  createdAt: string;
  playerCount: number;
  scoreCount: number;
  lastScoreAt: string | null;
  isDemo: boolean;
};

type State =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "ready"; events: AdminEvent[] };

const LABEL: Record<EventStatus, string> = {
  live: "Live",
  upcoming: "Upcoming",
  completed: "Completed",
  abandoned: "Inactive",
};

/**
 * Every outing the league has ever created.
 *
 * The only list of events in the app: an event's token is its credential, so
 * this is admin-only and reads through `admin_events()` rather than the table.
 */
export function EventsAdmin() {
  const { href } = useClub();
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_events");

    if (error) {
      setState({ status: "denied" });
      return;
    }

    setState({ status: "ready", events: (data ?? []) as unknown as AdminEvent[] });
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (state.status === "loading") {
    return <Centered>Loading…</Centered>;
  }

  if (state.status === "denied") {
    return (
      <Centered>
        <p>Only a league admin can see every outing.</p>
        <Link href={href("/league")} className="mt-3 underline">
          Back to the league
        </Link>
      </Centered>
    );
  }

  const { events } = state;
  const inactive = events.filter(
    (e) =>
      !e.isDemo &&
      (eventStatus(e) === "abandoned" || eventStatus(e) === "completed"),
  );

  const remove = async (event: AdminEvent) => {
    setBusy(true);
    setNotice(null);

    const { error } = await supabase.rpc("admin_delete_event", {
      in_event_id: event.id,
    });

    setBusy(false);
    setConfirming(null);

    if (error) {
      setNotice(error.message);
      return;
    }

    await load();
  };

  const changePin = async (event: AdminEvent, pin: string | null) => {
    const { data, error } = await supabase.rpc("admin_set_event_pin", {
      in_event_id: event.id,
      in_pin: pin,
    });

    if (error) return { error: error.message };

    return { pin: (data as { pin: string }).pin };
  };

  const clearDemo = async () => {
    const { error } = await supabase.rpc("admin_clear_demo_scores");

    if (error) return error.message;

    await load();
    return null;
  };

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-5 sm:p-8">
      <header>
        <Link href={href("/league")} className="font-mono text-xs underline">
          ← The league
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="meta">Admin</p>
            <h1 className="font-display text-3xl font-bold tracking-tight">
              All outings
            </h1>
          </div>

          <Link
            href={href("/outings/new")}
            className="min-h-11 bg-forest-deep px-4 py-3 font-mono text-xs tracking-wider text-cream uppercase"
          >
            New outing
          </Link>
        </div>

        <p className="mt-2 font-mono text-xs text-ink-soft">
          {events.length} total
          {inactive.length > 0 && ` · ${inactive.length} inactive`}
        </p>
      </header>

      {notice && (
        <p
          role="alert"
          className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
        >
          {notice}
        </p>
      )}

      {events.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">
          No outings yet.
        </p>
      ) : (
        <div className="space-y-3">
          {events.map((event) => {
            const status = eventStatus(event);
            const refusal = deleteRefusal(event);

            return (
              <article
                key={event.id}
                className="border border-hairline bg-card px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/event/${event.shareToken}`}
                      className="font-display text-lg font-bold hover:underline"
                    >
                      {event.name}
                    </Link>
                    <p className="font-mono text-xs text-ink-soft">
                      {event.playedOn}
                      {event.courseName && ` · ${event.courseName}`} ·{" "}
                      {getFormat(event.format).label}
                    </p>
                  </div>

                  <span
                    className={`shrink-0 border px-2 py-1 font-mono text-xs tracking-wider uppercase ${
                      status === "live" && !event.isDemo
                        ? "border-clay text-clay"
                        : status === "abandoned" && !event.isDemo
                          ? "border-hairline text-ink-soft"
                          : "border-forest text-forest"
                    }`}
                  >
                    {event.isDemo ? "Demo" : LABEL[status]}
                  </span>
                </div>

                <p className="mt-2 font-mono text-xs text-ink-soft">
                  {event.playerCount} players · {event.scoreCount} scores
                  {event.lastScoreAt &&
                    ` · last ${event.lastScoreAt.slice(0, 10)}`}
                </p>

                <div className="mt-3 flex flex-wrap gap-4 border-t border-dashed border-hairline pt-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSharing(sharing === event.id ? null : event.id)
                    }
                    className="font-mono text-xs text-forest underline"
                  >
                    {sharing === event.id ? "Hide invite" : "Invite & QR"}
                  </button>

                  <Link
                    href={`/event/${event.shareToken}/admin`}
                    className="font-mono text-xs text-ink-soft underline"
                  >
                    Event admin
                  </Link>

                  <button
                    type="button"
                    onClick={() =>
                      setPinFor(pinFor === event.id ? null : event.id)
                    }
                    className="font-mono text-xs text-ink-soft underline"
                  >
                    {pinFor === event.id ? "Close PIN" : "Change PIN"}
                  </button>

                  {event.isDemo ? (
                    <ClearDemoScores
                      scoreCount={event.scoreCount}
                      onClear={clearDemo}
                    />
                  ) : confirming === event.id ? (
                    <span className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(event)}
                        className="font-mono text-xs font-bold text-clay underline disabled:opacity-40"
                      >
                        {busy ? "Deleting…" : "Delete for good"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="font-mono text-xs text-ink-soft underline"
                      >
                        Keep it
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={!canDeleteEvent(event)}
                      title={refusal ?? undefined}
                      onClick={() => setConfirming(event.id)}
                      className="font-mono text-xs text-clay underline disabled:cursor-not-allowed disabled:text-ink-soft disabled:no-underline disabled:opacity-60"
                    >
                      Delete
                    </button>
                  )}
                </div>

                {confirming === event.id && (
                  <p className="mt-2 font-mono text-xs text-clay">
                    This deletes {event.name} and its {event.scoreCount} scores.
                    There is no undo.
                  </p>
                )}

                {event.isDemo && (
                  <p className="mt-2 font-mono text-xs text-ink-soft">
                    The home page&apos;s &ldquo;One-off outing&rdquo; panel
                    opens this demo, so it can&apos;t be deleted.
                  </p>
                )}

                {refusal && !event.isDemo && confirming !== event.id && (
                  <p className="mt-2 font-mono text-xs text-ink-soft">
                    {refusal}
                  </p>
                )}

                {pinFor === event.id && (
                  <ChangePinForm
                    key={event.id}
                    eventName={event.name}
                    onSubmit={(pin) => changePin(event, pin)}
                  />
                )}

                {sharing === event.id && (
                  <div className="mt-3 border-t border-dashed border-hairline pt-3">
                    <EventShare
                      token={event.shareToken}
                      eventName={event.name}
                      className="mx-auto max-w-xs"
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}

/**
 * Reset the demo for the next visitor. Behind a second click, with the count
 * in it, like every other destructive button on this page.
 */
function ClearDemoScores({
  scoreCount,
  onClear,
}: {
  scoreCount: number;
  onClear: () => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (scoreCount === 0) {
    return (
      <span className="font-mono text-xs text-ink-soft">No scores yet</span>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="font-mono text-xs text-clay underline"
      >
        Clear scores
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(await onClear());
          setBusy(false);
          setConfirming(false);
        }}
        className="font-mono text-xs font-bold text-clay underline disabled:opacity-40"
      >
        {busy ? "Clearing…" : `Clear all ${scoreCount}`}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="font-mono text-xs text-ink-soft underline"
      >
        Keep them
      </button>
      {error && <span className="font-mono text-xs text-clay">{error}</span>}
    </span>
  );
}

/**
 * Set a new admin PIN for an outing. Blank makes one up. Either way it is
 * shown once, because only its hash is kept; and anyone who unlocked the
 * outing's admin page with the old PIN is signed out of it.
 */
function ChangePinForm({
  eventName,
  onSubmit,
}: {
  eventName: string;
  onSubmit: (pin: string | null) => Promise<{ pin?: string; error?: string }>;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();

        const chosen = pin.trim();
        const problem = chosen === "" ? null : pinProblem(chosen);
        if (problem) return setError(problem);

        setError(null);
        setBusy(true);
        const result = await onSubmit(chosen === "" ? null : chosen);
        setBusy(false);

        if (result.error) return setError(result.error);

        setSaved(result.pin ?? null);
        setPin("");
      }}
      className="mt-3 space-y-2 border-t border-dashed border-hairline pt-3"
    >
      <p className="font-mono text-xs text-ink-soft">
        New admin PIN for {eventName}. Leave it blank to have one made up.
        Anyone signed in to its admin page with the old PIN is signed out.
      </p>

      <div className="flex flex-wrap gap-2">
        <input
          value={pin}
          onChange={(e) =>
            setPin(
              [...e.target.value]
                .filter((c) => c >= "0" && c <= "9")
                .join("")
                .slice(0, 8),
            )
          }
          inputMode="numeric"
          autoComplete="off"
          placeholder="8 digits, or blank"
          aria-label={`New admin PIN for ${eventName}`}
          className="min-h-11 w-44 border border-hairline bg-cream px-3 font-mono text-sm tracking-widest tabular-nums focus:outline-2 focus:outline-forest"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Saving…" : pin === "" ? "Make one up" : "Save PIN"}
        </button>
      </div>

      {error && (
        <p role="alert" className="font-mono text-xs text-clay">
          {error}
        </p>
      )}

      {saved && (
        <div className="border-2 border-forest bg-cream px-3 py-2">
          <p className="meta">New PIN — shown once</p>
          <p className="font-display text-2xl font-bold tracking-widest tabular-nums">
            {saved}
          </p>
          <p className="font-mono text-xs text-ink-soft">
            Only its hash is stored, so write it down.
          </p>
        </div>
      )}
    </form>
  );
}
