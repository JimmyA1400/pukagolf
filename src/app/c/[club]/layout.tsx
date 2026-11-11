import { Suspense } from "react";

import { ClubGate } from "@/lib/club";

/**
 * Every page inside a club: /c/pukagolf/league, /c/moose-ridge/admin.
 *
 * The club comes from the address, and ClubGate looks it up for the signed-in
 * player before the page renders, so every component below can ask which club
 * and which league it is showing (useClub) instead of assuming the only one.
 *
 * moose-ridge.pukagolf.com will reach these same pages: proxy.ts rewrites a
 * club's own domain onto /c/<club>, so nothing here changes when it exists.
 */
export default async function ClubLayout({ children, params }: LayoutProps<"/c/[club]">) {
  const { club } = await params;

  // The league picked in the club is read from ?league=, which needs a
  // Suspense boundary above it.
  return (
    <Suspense>
      <ClubGate slug={club}>{children}</ClubGate>
    </Suspense>
  );
}
