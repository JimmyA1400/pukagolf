"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { MyClub } from "@/lib/club-paths";
import { createClient, isConfigured } from "@/lib/supabase/client";

type Welcome = { name: string; clubs: MyClub[] };

/**
 * On the landing page, for someone already signed in: who they are and a
 * straight way into each of their clubs, rather than the same "sign in to
 * score" a stranger sees. Nothing at all when signed out.
 */
export function HomeWelcome() {
  const supabase = useMemo(() => (isConfigured ? createClient() : null), []);
  const [welcome, setWelcome] = useState<Welcome | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const [profile, clubs] = await Promise.all([
        supabase.from("profiles").select("full_name").eq("id", session.user.id).maybeSingle(),
        supabase.rpc("my_clubs"),
      ]);
      if (cancelled) return;

      setWelcome({
        name: profile.data?.full_name ?? "you",
        clubs: ((clubs.data ?? []) as unknown as MyClub[]).filter((c) => !c.viaPlatform),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  if (!welcome) return null;

  return (
    <section className="mt-6 border-2 border-forest bg-card px-5 py-4">
      <p className="meta">Signed in as {welcome.name}</p>
      {welcome.clubs.length === 0 ? (
        <p className="mt-1 font-mono text-xs text-ink-soft">
          You aren&apos;t in a club yet. Your club&apos;s join link brings you in.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {welcome.clubs.map((club) => (
            <li key={club.id}>
              <Link
                href={`/c/${club.slug}/league`}
                className="inline-flex min-h-11 items-center font-display text-lg font-bold text-forest underline"
              >
                {club.name} &rarr;
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
