"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { MyClub } from "@/lib/club-paths";
import { createClient } from "@/lib/supabase/client";

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "ready"; clubs: MyClub[] };

/**
 * Where /league goes now that there is more than one. One club: straight to
 * its league, so a player in one club never sees this page. Several: a list
 * to pick from. None: say so.
 *
 * Every link and bookmark that says /league keeps working this way, including
 * the home-screen icon of anyone who installed the app before clubs.
 */
export function ClubChooser() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        if (!cancelled) setState({ status: "signed-out" });
        return;
      }

      const { data, error } = await supabase.rpc("my_clubs");
      if (cancelled) return;

      if (error) {
        setState({ status: "error", message: error.message });
        return;
      }

      const clubs = (data ?? []) as unknown as MyClub[];
      if (clubs.length === 1) {
        router.replace(`/c/${clubs[0].slug}/league`);
        return;
      }

      setState({ status: "ready", clubs });
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, router]);

  if (state.status === "loading") return <Centered>Finding your club…</Centered>;

  if (state.status === "signed-out") {
    return (
      <Centered>
        <p>Sign in to see your league.</p>
        <Link href="/sign-in" className="mt-3 inline-block underline">
          Sign in
        </Link>
      </Centered>
    );
  }

  if (state.status === "error") return <Centered>{state.message}</Centered>;

  if (state.clubs.length === 0) {
    return (
      <Centered>
        <p>You aren&apos;t in a club yet. Ask your pro shop for its link.</p>
      </Centered>
    );
  }

  return (
    <main className="mx-auto w-full max-w-md p-5 sm:p-8">
      <h1 className="font-display text-2xl font-bold">Your clubs</h1>
      <ul className="mt-4 border-t border-hairline">
        {state.clubs.map((club) => (
          <li key={club.id} className="border-b border-hairline">
            <Link
              href={`/c/${club.slug}/league`}
              className="flex min-h-12 items-center justify-between py-3"
            >
              <span className="font-display text-lg font-bold">{club.name}</span>
              <span className="font-mono text-xs tracking-wider text-ink-soft uppercase">
                {club.role === "player" || !club.role ? "" : club.role}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}
