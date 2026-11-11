"use client";

import Link from "next/link";

import { PUKAGOLF_SLUG } from "@/lib/club-paths";
import { useClub } from "@/lib/club";

/**
 * Outings, tournaments, charities and the owner's admin page stay PukaGolf's
 * own for now, as decided: clubs are given them later. Under any other club
 * the page says so instead of showing PukaGolf's, or an empty screen.
 *
 * The database already confines each of them; this is the page being honest
 * about what it can show, not the lock.
 */
export function PukaGolfOnly({ what, children }: { what: string; children: React.ReactNode }) {
  const { club, href } = useClub();

  if (club.slug === PUKAGOLF_SLUG) return <>{children}</>;

  return (
    <main className="mx-auto w-full max-w-md p-8 text-center font-mono text-sm text-ink-soft">
      <p>
        {what} aren&apos;t available at {club.name} yet.
      </p>
      <Link href={href("/league")} className="mt-3 inline-block underline">
        Back to the league
      </Link>
    </main>
  );
}
