"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { RsvpControl } from "@/components/RsvpControl";
import { getFormat } from "@/lib/formats";
import { createClient } from "@/lib/supabase/client";
import { TournamentResultsEditor } from "@/components/TournamentResultsEditor";
import { useTournaments } from "@/lib/useTournaments";
import { useClub } from "@/lib/club";

type Result = {
  player_id: string;
  position: number;
  gross: number | null;
  notes: string | null;
  name: string;
};

/** One tournament: the detail, the field, and the results once played. */
export function TournamentDetail({ id }: { id: string }) {
  const { href } = useClub();
  const supabase = useMemo(() => createClient(), []);
  const { state, setRsvp } = useTournaments();
  const [results, setResults] = useState<Result[]>([]);

  const loadResults = useCallback(async () => {
    const [rows, players] = await Promise.all([
      supabase
        .from("tournament_results")
        .select("*")
        .eq("tournament_id", id)
        .order("position"),
      supabase.from("profiles").select("id, full_name"),
    ]);

    const nameOf = new Map((players.data ?? []).map((p) => [p.id, p.full_name]));

    setResults(
      (rows.data ?? []).map((r) => ({
        ...r,
        name: nameOf.get(r.player_id) ?? "Unknown",
      })),
    );
  }, [supabase, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadResults();
  }, [loadResults]);

  if (state.status === "loading") return <Centered>Loading…</Centered>;

  if (state.status === "signed-out") {
    return (
      <Centered>
        <p>Sign in to see this tournament.</p>
        <Link href="/sign-in" className="mt-3 underline">
          Sign in
        </Link>
      </Centered>
    );
  }

  const tournament = state.tournaments.find((t) => t.id === id);

  if (!tournament) {
    return (
      <Centered>
        <p>No tournament found.</p>
        <Link href={href("/tournaments")} className="mt-3 underline">
          Back to tournaments
        </Link>
      </Centered>
    );
  }

  const t = tournament;
  const played = t.completed_at !== null;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-5 sm:p-8">
      <header>
        <Link href={href("/tournaments")} className="font-mono text-xs underline">
          ← Tournaments
        </Link>

        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
          {t.name}
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          {t.played_on}
          {t.course_name && ` · ${t.course_name}`} · {getFormat(t.format).label}
          {t.entry_fee > 0 && ` · $${Number(t.entry_fee).toFixed(0)} entry`}
        </p>

        {t.description && (
          <p className="mt-3 font-display text-[0.95rem]">{t.description}</p>
        )}

        {Number(t.raised) > 0 && (
          <p className="mt-2 font-mono text-xs text-forest">
            ${Number(t.raised).toFixed(0)} raised for charity
          </p>
        )}
      </header>

      {!played && (
        <section>
          <h2 className="section-head mb-3 pb-2 text-xl">Your entry</h2>
          <RsvpControl
            value={t.myStatus}
            lockedAt={t.rsvp_lock_at}
            disabled={t.spotsRemaining === 0 && t.myStatus !== "in"}
            onChange={(status) => void setRsvp(t.id, status)}
          />
        </section>
      )}

      <section>
        <div className="section-head mb-3 flex items-baseline justify-between pb-2">
          <h2 className="text-xl">Field</h2>
          <span className="meta">
            {t.field.length}
            {t.field_limit !== null && ` of ${t.field_limit}`}
          </span>
        </div>

        {t.field.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">Nobody yet.</p>
        ) : (
          <ul className="divide-y divide-hairline border border-hairline bg-card">
            {t.field.map((player) => (
              <li key={player.playerId} className="px-4 py-2.5">
                <Link
                  href={`/players/${player.playerId}`}
                  className="font-display text-[0.95rem] hover:underline"
                >
                  {player.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {state.isAdmin && (
        <section>
          <div className="section-head mb-3 flex items-baseline justify-between pb-2">
            <h2 className="text-xl">Enter results</h2>
            <span className="meta">Admin</span>
          </div>
          <TournamentResultsEditor
            tournamentId={t.id}
            field={t.field}
            completed={played}
            onSaved={() => void loadResults()}
          />
        </section>
      )}

      {played && (
        <section>
          <h2 className="section-head mb-3 pb-2 text-xl">Results</h2>

          {results.length === 0 ? (
            <p className="font-mono text-xs text-ink-soft">
              Results haven&apos;t been posted yet.
            </p>
          ) : (
            <ul className="divide-y divide-hairline border border-hairline bg-card">
              {results.map((r) => (
                <li
                  key={r.player_id}
                  className="flex items-center gap-3 px-4 py-2.5"
                >
                  <span className="w-6 shrink-0 font-mono text-sm text-ink-soft">
                    {r.position}
                  </span>
                  <Link
                    href={`/players/${r.player_id}`}
                    className="min-w-0 flex-1 truncate font-display text-[0.95rem] font-semibold hover:underline"
                  >
                    {r.name}
                  </Link>
                  <span className="shrink-0 font-mono text-sm tabular-nums">
                    {r.gross ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
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
