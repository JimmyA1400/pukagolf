"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  HandicapCard,
  RecentRounds,
  StatsBlock,
} from "@/components/PlayerRecord";
import { createClient } from "@/lib/supabase/client";
import { teePreferenceLabel } from "@/lib/tee-preference";
import { TeamEventResults } from "@/components/TeamEventResults";
import { usePlayerRounds } from "@/lib/usePlayerRounds";
import type { Profile } from "@/lib/supabase/types";

/**
 * Another player's record, read only.
 *
 * Phone is deliberately absent: it is collected so the organiser can reach
 * people, not so the roster becomes a directory.
 */
export function PublicProfile({ playerId }: { playerId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [player, setPlayer] = useState<
    Profile | null | "missing" | "signed-out"
  >(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Signed out, RLS returns no row — which is indistinguishable from a
      // player who does not exist unless the session is checked first.
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (!cancelled) setPlayer("signed-out");
        return;
      }

      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", playerId)
        .maybeSingle();

      if (!cancelled) setPlayer((data as Profile) ?? "missing");
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, playerId]);

  const { rounds, index, stats } = usePlayerRounds(
    playerId,
    typeof player === "object" && player !== null
      ? player.handicap_index
      : null,
  );

  if (player === null) return <Centered>Loading…</Centered>;

  if (player === "signed-out") {
    return (
      <Centered>
        <p>Sign in to see a player&apos;s record.</p>
        <Link href="/sign-in" className="mt-3 underline">
          Sign in
        </Link>
      </Centered>
    );
  }

  if (player === "missing") {
    return (
      <Centered>
        <p>No player found.</p>
        <Link href="/league" className="mt-3 underline">
          Back to the league
        </Link>
      </Centered>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-5 sm:p-8">
      <header>
        <p className="meta">Player</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          {player.full_name}
        </h1>

        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-hairline pt-4">
          <div>
            <dt className="meta">Preferred tees</dt>
            <dd className="font-display text-xl font-bold">
              {teePreferenceLabel(player.preferred_tee) ?? "—"}
            </dd>
          </div>
        </dl>
      </header>

      <HandicapCard result={index} unrated={stats.unratedRounds} />

      <StatsBlock stats={stats} />

      <section>
        <h2 className="section-head mb-3 pb-2 text-xl">Recent scores</h2>
        <RecentRounds rounds={rounds} />
      </section>

      <TeamEventResults playerId={player.id} />
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
