import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Offline · PukaGolf",
};

/**
 * What the service worker serves when a page cannot be fetched at all.
 *
 * Deliberately static and self-contained: it is cached at install and served
 * with no network, so it cannot depend on anything loaded at runtime. It also
 * does not pretend to show scores — every number on this site is live, and a
 * cached leaderboard is worse than none because it looks current.
 */
export default function Offline() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center p-6 sm:p-8">
      <p className="meta">PukaGolf</p>
      <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">
        No signal
      </h1>

      <p className="mt-3 font-display text-lg">
        Scores need a connection, so there is nothing to show until you have
        one.
      </p>

      <p className="mt-4 font-mono text-xs text-ink-soft">
        Keep the card on paper for now and enter the holes when you are back in
        range. Scores already entered are kept on this phone and send by
        themselves once there is signal. If a phone dies, finish the round on
        paper and take the card to the pro shop staff.
      </p>

      <a
        href="/league"
        className="mt-6 min-h-12 bg-forest-deep px-4 py-3.5 text-center font-mono text-xs tracking-wider text-cream uppercase"
      >
        Try again
      </a>
    </main>
  );
}
