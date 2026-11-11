"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { LeagueChoices } from "@/components/AskForLeague";
import type { PublicClub } from "@/lib/club-paths";
import { createClient, isConfigured } from "@/lib/supabase/client";

type State =
  | { status: "loading" }
  | { status: "no-such-club" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      club: PublicClub;
      signedIn: boolean;
      /** Where the caller stands with this club, if anywhere. */
      standing: "active" | "requested" | "removed" | null;
    };

/**
 * Asking to join a club.
 *
 * Signed out: make an account or sign in, and come straight back here (both
 * pages return to ?next=). Signed in: one button, and the request goes to the
 * club's admins, who approve it. Nobody is let in by having the link: the pro
 * shop decides.
 */
export function JoinClub({ slug }: { slug: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [address, session] = await Promise.all([
      supabase.rpc("club_public", { in_slug: slug }),
      supabase.auth.getSession(),
    ]);

    if (address.error) {
      setState({ status: "error", message: address.error.message });
      return;
    }

    if (!address.data) {
      setState({ status: "no-such-club" });
      return;
    }

    const signedIn = Boolean(session.data.session);
    const standing = signedIn
      ? ((await supabase.rpc("my_club_request", { in_slug: slug })).data as
          | "active"
          | "requested"
          | "removed"
          | null)
      : null;

    setState({
      status: "ready",
      club: address.data as unknown as PublicClub,
      signedIn,
      standing: standing ?? null,
    });
  }, [supabase, slug]);

  useEffect(() => {
    if (!isConfigured) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const ask = async () => {
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.rpc("club_request_join", { in_slug: slug });
    setBusy(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    await load();
  };

  const here = `/join/${slug}`;

  return (
    <main className="mx-auto w-full max-w-md p-6 sm:p-8">
      <Link href="/" className="font-display text-base font-bold tracking-tight">
        Puka<span className="text-forest">Golf</span>
      </Link>

      {state.status === "loading" && (
        <p className="mt-8 font-mono text-sm text-ink-soft">Finding the club…</p>
      )}

      {state.status === "no-such-club" && (
        <p className="mt-8 font-mono text-sm text-ink-soft">
          There&apos;s no club at this address. Check the link with your pro shop.
        </p>
      )}

      {state.status === "error" && (
        <p className="mt-8 font-mono text-sm text-clay">{state.message}</p>
      )}

      {state.status === "ready" && (
        <section className="mt-8">
          <p className="meta">Join</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            {state.club.name}
          </h1>
          {state.club.isDemo && (
            <p className="mt-1 font-mono text-xs text-ink-soft">
              A demonstration club, not run by the course itself.
            </p>
          )}

          <div className="mt-6 space-y-4">
            {!state.signedIn && (
              <>
                <p className="font-mono text-sm text-ink-soft">
                  Make an account, or sign in, then ask to join. The pro shop
                  approves every new member.
                </p>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href={`/signup?next=${encodeURIComponent(here)}`}
                    className="min-h-11 bg-forest-deep px-4 py-3 font-mono text-xs tracking-wider text-cream uppercase"
                  >
                    Make an account
                  </Link>
                  <Link
                    href={`/sign-in?next=${encodeURIComponent(here)}`}
                    className="min-h-11 border border-hairline px-4 py-3 font-mono text-xs tracking-wider uppercase"
                  >
                    Sign in
                  </Link>
                </div>
              </>
            )}

            {state.signedIn && state.standing === "active" && (
              <>
                <p className="font-mono text-sm text-ink-soft">
                  You&apos;re a member of {state.club.name}.
                </p>
                <Link
                  href={`/c/${state.club.slug}/league`}
                  className="inline-block min-h-11 bg-forest-deep px-4 py-3 font-mono text-xs tracking-wider text-cream uppercase"
                >
                  Go to the league
                </Link>
                <LeagueChoices
                  clubId={state.club.id}
                  clubName={state.club.name}
                  intro={
                    <p className="mt-6 mb-2 font-mono text-sm text-ink-soft">
                      The club&apos;s leagues. Ask to play in another, and the pro shop
                      will add you.
                    </p>
                  }
                />
              </>
            )}

            {state.signedIn && state.standing === "requested" && (
              <p role="status" className="border border-forest bg-card px-4 py-3 font-mono text-sm text-forest">
                Your request is with {state.club.name}&apos;s pro shop. You&apos;ll be
                able to open the league here once they approve it.
              </p>
            )}

            {state.signedIn && (state.standing === null || state.standing === "removed") && (
              <>
                <p className="font-mono text-sm text-ink-soft">
                  Ask to join, and the pro shop will approve you.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void ask()}
                  className="min-h-11 bg-forest-deep px-4 py-3 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-50"
                >
                  {busy ? "Asking…" : `Ask to join ${state.club.name}`}
                </button>
              </>
            )}

            {message && (
              <p role="alert" className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay">
                {message}
              </p>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
