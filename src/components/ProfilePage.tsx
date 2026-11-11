"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PlayerDetailsForm } from "@/components/PlayerDetailsForm";
import { RsvpControl } from "@/components/RsvpControl";
import {
  HandicapCard,
  RecentRounds,
  StatsBlock,
} from "@/components/PlayerRecord";
import { TeamEventResults } from "@/components/TeamEventResults";
import { friendlyDate } from "@/lib/league-week";
import { usePlayerRounds } from "@/lib/usePlayerRounds";
import { createClient } from "@/lib/supabase/client";
import { teePreferenceLabel } from "@/lib/tee-preference";
import { formatTimeOfDay, preferredTeeTimeChoices, usePlayer } from "@/lib/usePlayer";

/**
 * The player's own profile: their details, and their answer for every upcoming
 * round.
 *
 * The handicap shown here is the self-reported one. Step 6 replaces it with a
 * figure calculated from posted scores.
 */
export function ProfilePage() {
  const router = useRouter();
  const { state, saveDetails, setRsvp } = usePlayer();

  // Named apart from `rounds` below, which is the UPCOMING rounds from state —
  // one is a score history, the other a fixture list.
  // Hooks cannot run conditionally, so this comes before the early returns.
  const { rounds: scoreHistory, index, stats } = usePlayerRounds(
    state.status === "ready" ? state.profile.id : null,
    state.status === "ready" ? state.profile.handicap_index : null,
  );

  if (state.status === "loading") {
    return <Centered>Loading…</Centered>;
  }

  if (state.status === "signed-out") {
    return (
      <Centered>
        <p>You need an account to see a profile.</p>
        <div className="mt-3 flex gap-4">
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>
          <Link href="/signup" className="underline">
            Join the league
          </Link>
        </div>
      </Centered>
    );
  }

  const { profile, rounds } = state;
  const teeTimes = preferredTeeTimeChoices(profile.preferred_tee_time);

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-5 sm:p-8">
      <header>
        <Link href="/league" className="font-mono text-xs underline">
          ← The league
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="meta">Profile</p>
            <NameEditor
              name={profile.full_name}
              onSave={(fullName) =>
                // Everything else as it is: save_player_details takes the
                // whole set, and applies the same rules it does at signup.
                saveDetails({
                  fullName,
                  phone: profile.phone,
                  handicapIndex: profile.handicap_index,
                  preferredTeeTime: profile.preferred_tee_time,
                  preferredTee: profile.preferred_tee,
                })
              }
            />
          </div>

          <button
            type="button"
            onClick={async () => {
              await createClient().auth.signOut();
              router.push("/sign-in");
              router.refresh();
            }}
            className="font-mono text-xs text-ink-soft underline"
          >
            Sign out
          </button>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-hairline pt-4">
          <Stat
            label="Preferred tee time"
            value={formatTimeOfDay(profile.preferred_tee_time) || "—"}
          />
          <Stat
            label="Preferred tees"
            value={teePreferenceLabel(profile.preferred_tee) ?? "—"}
          />
        </dl>
      </header>

      <HandicapCard result={index} unrated={stats.unratedRounds} />

      <StatsBlock stats={stats} />

      <section>
        <h2 className="section-head mb-3 pb-2 text-xl">Recent scores</h2>
        <RecentRounds rounds={scoreHistory} />
      </section>

      <TeamEventResults playerId={profile.id} />

      <section>
        <h2 className="section-head mb-3 pb-2 text-xl">Upcoming rounds</h2>

        {rounds.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">
            Nothing scheduled yet.
          </p>
        ) : (
          <div className="space-y-3">
            {rounds.map((round) => (
              <div
                key={round.id}
                className="border border-hairline bg-card px-4 py-3"
              >
                <p className="font-display text-base font-bold">{round.name}</p>
                {round.onSheetAt !== undefined ? (
                  // Already in a group: nothing to answer, just when to be there.
                  <p className="font-mono text-xs text-ink-soft">
                    {round.league && `${round.league} · `}
                    {friendlyDate(round.played_on)} · you&rsquo;re on the tee sheet
                    {round.onSheetAt &&
                      `, tee time ${new Date(round.onSheetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
                  </p>
                ) : (
                  <>
                    <p className="mb-2 font-mono text-xs text-ink-soft">
                      {round.league && `${round.league} · `}
                      {friendlyDate(round.played_on)}
                      {round.rsvp_lock_at &&
                        new Date(round.rsvp_lock_at) > new Date() &&
                        ` · answers close ${new Date(round.rsvp_lock_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
                    </p>
                    <RsvpControl
                      value={round.myStatus}
                      lockedAt={round.rsvp_lock_at}
                      onChange={(status) => void setRsvp(round.id, status)}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="section-head mb-3 pb-2 text-xl">Edit details</h2>
        <PlayerDetailsForm
          initial={{
            fullName: profile.full_name,
            phone: profile.phone,
            handicapIndex: profile.handicap_index,
            preferredTeeTime: profile.preferred_tee_time,
            preferredTee: profile.preferred_tee,
          }}
          teeTimes={teeTimes}
          submitLabel="Save changes"
          onSubmit={saveDetails}
        />
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <dt className="meta">{label}</dt>
      <dd className="font-display text-xl font-bold">{value}</dd>
      {note && (
        <dd className="font-mono text-[0.65rem] text-ink-soft">{note}</dd>
      )}
    </div>
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
 * The name at the top of the profile, with a way to fix it in place.
 *
 * It could always be changed under Edit details, at the bottom of the page,
 * but a misspelt name is the first thing a player notices and the last place
 * they would look.
 */
function NameEditor({
  name,
  onSave,
}: {
  name: string;
  onSave: (fullName: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">
          {name}
        </h1>
        <button
          type="button"
          onClick={() => {
            setDraft(name);
            setError(null);
            setEditing(true);
          }}
          className="font-mono text-xs text-forest underline"
        >
          Change name
        </button>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();

        const words = draft.trim().split(" ").filter(Boolean);
        const cleaned = words.join(" ");

        // The same rule as signing up.
        if (words.length < 2) return setError("Enter your first and last name.");
        if (cleaned.length > 60) return setError("Keep it under 60 characters.");

        setBusy(true);
        const refusal = await onSave(cleaned);
        setBusy(false);

        if (refusal) return setError(refusal);
        setEditing(false);
      }}
      className="mt-1 space-y-2"
    >
      <label className="block">
        <span className="sr-only">Your name</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          autoComplete="name"
          className="min-h-12 w-full max-w-sm border border-hairline bg-cream px-3 font-display text-xl font-bold focus:outline-2 focus:outline-forest"
        />
      </label>

      {error && (
        <p role="alert" className="font-mono text-xs text-clay">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="min-h-10 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save name"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="font-mono text-xs text-ink-soft underline"
        >
          Cancel
        </button>
      </div>

      <p className="font-mono text-xs text-ink-soft">
        Changes it everywhere: leaderboards, scorecards and past rounds.
      </p>
    </form>
  );
}
