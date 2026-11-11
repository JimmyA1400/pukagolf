"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  clubPath,
  pickLeague,
  type ClubLeague,
  type MyClub,
  type PublicClub,
} from "@/lib/club-paths";
import { createClient } from "@/lib/supabase/client";

/**
 * The club a page under /c/<club> belongs to, and the league picked in it.
 *
 * Resolved in the browser, like every other read the league pages make, so it
 * goes through the same signed-in client and row level security, and the
 * browser tests can answer it the way they answer everything else.
 */

type ClubContextValue = {
  club: MyClub;
  /** Every club the caller belongs to, for the switcher. */
  clubs: MyClub[];
  /** The league being shown; null in a club that has none yet. */
  league: ClubLeague | null;
  /**
   * The ?league= the address asked for, when it isn't one the caller can
   * open (not one they play in, or no such league), so the page can say so
   * rather than quietly show another.
   */
  missingLeague: string | null;
  /** An address inside this club, keeping the league being looked at. */
  href: (path: string) => string;
  /** The same page in another league of this club. */
  leagueHref: (league: ClubLeague, path?: string) => string;
  /**
   * Look the club up again, say after a league is started, so the league
   * picker has it. Resolves with the caller's clubs as they are now.
   */
  reloadClub: () => Promise<MyClub[]>;
};

const ClubContext = createContext<ClubContextValue | null>(null);

/** For components that only ever render inside a club. */
export function useClub(): ClubContextValue {
  const value = useContext(ClubContext);
  if (!value) throw new Error("useClub() used outside a /c/<club> page.");
  return value;
}

/** For components shared with pages outside any club, like the navigation. */
export function useOptionalClub(): ClubContextValue | null {
  return useContext(ClubContext);
}

type GateState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "no-such-club" }
  | { status: "not-a-member"; club: PublicClub }
  | { status: "error"; message: string }
  | { status: "ready"; club: MyClub; clubs: MyClub[] };

/**
 * Looks the club up and stands between it and the page: nobody gets a club
 * page for a club they aren't in. That is a courtesy on top of the database,
 * which wouldn't return them anything anyway; the point is to say so, rather
 * than show an empty leaderboard.
 */
export function ClubGate({ slug, children }: { slug: string; children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<GateState>({ status: "loading" });
  // Bumped to look the club up again; whoever asked is told when it's done.
  const [version, setVersion] = useState(0);
  const waiting = useRef<((clubs: MyClub[]) => void)[]>([]);

  const reloadClub = useCallback(
    () =>
      new Promise<MyClub[]>((resolve) => {
        waiting.current.push(resolve);
        setVersion((v) => v + 1);
      }),
    [],
  );

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

      const [mine, address] = await Promise.all([
        supabase.rpc("my_clubs"),
        supabase.rpc("club_public", { in_slug: slug }),
      ]);
      if (cancelled) return;

      if (mine.error || address.error) {
        for (const resolve of waiting.current.splice(0)) resolve([]);
        setState({
          status: "error",
          message: (mine.error ?? address.error)?.message ?? "Couldn't load the club.",
        });
        return;
      }

      const clubs = (mine.data ?? []) as unknown as MyClub[];
      const club = clubs.find((c) => c.slug === slug);
      for (const resolve of waiting.current.splice(0)) resolve(clubs);

      if (club) {
        setState({ status: "ready", club, clubs });
        // The platform admin looking at a club they aren't in: written down,
        // so the club can always see when it was looked at from outside.
        if (club.viaPlatform) void supabase.rpc("platform_note_view", { in_club_id: club.id });
      }
      else if (address.data) {
        setState({ status: "not-a-member", club: address.data as unknown as PublicClub });
      } else setState({ status: "no-such-club" });
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, slug, version]);

  switch (state.status) {
    case "loading":
      return <Centered>Loading the club…</Centered>;
    case "signed-out":
      return (
        <Centered>
          <p>Sign in to see your club.</p>
          <Link href="/sign-in" className="mt-3 inline-block underline">
            Sign in
          </Link>
        </Centered>
      );
    case "no-such-club":
      return (
        <Centered>
          <p>There&apos;s no club at this address.</p>
          <Link href="/league" className="mt-3 inline-block underline">
            Your clubs
          </Link>
        </Centered>
      );
    case "not-a-member":
      return (
        <Centered>
          <p>You aren&apos;t a member of {state.club.name}.</p>
          <Link href="/league" className="mt-3 inline-block underline">
            Your clubs
          </Link>
        </Centered>
      );
    case "error":
      return <Centered>{state.message}</Centered>;
    case "ready":
      return (
        <ClubProvider club={state.club} clubs={state.clubs} reloadClub={reloadClub}>
          {state.club.viaPlatform && (
            <p className="bg-sand px-4 py-1 text-center font-mono text-xs text-forest-deep">
              You&apos;re looking at {state.club.name} as the platform admin. The visit is in
              the audit log.
            </p>
          )}
          {children}
        </ClubProvider>
      );
  }
}

function ClubProvider({
  club,
  clubs,
  reloadClub,
  children,
}: {
  club: MyClub;
  clubs: MyClub[];
  reloadClub: () => Promise<MyClub[]>;
  children: React.ReactNode;
}) {
  const wanted = useSearchParams().get("league");

  const value = useMemo<ClubContextValue>(() => {
    const league = pickLeague(club.leagues, wanted);

    return {
      club,
      clubs,
      league,
      missingLeague: wanted && league?.slug !== wanted ? wanted : null,
      href: (path) => clubPath(club.slug, path, league, club.leagues),
      leagueHref: (other, path = "/league") => clubPath(club.slug, path, other, club.leagues),
      reloadClub,
    };
  }, [club, clubs, wanted, reloadClub]);

  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}
