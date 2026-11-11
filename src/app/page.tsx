import Link from "next/link";

import { HomeWelcome } from "@/components/HomeWelcome";
import { SAMPLE_EVENT_TOKEN } from "@/lib/sample-event";



/**
 * Landing. The two surfaces are deliberately separate: the league needs an
 * account, an event needs only its link.
 *
 * There is no "browse events" list here on purpose — an event's token is its
 * credential, so listing them would hand out access.
 */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center p-6 sm:p-8">
      <h1 className="font-display text-4xl font-bold tracking-tight">
        Puka<span className="text-forest">Golf</span>
      </h1>
      <p className="mt-2 font-mono text-sm text-ink-soft">
        Live golf scoring.
      </p>

      <HomeWelcome />

      <div className="mt-8 space-y-3">
        <Link
          href="/league"
          className="block border border-hairline bg-card px-5 py-4 transition-colors hover:border-forest"
        >
          <span className="font-display text-lg font-bold">
            Weekly league →
          </span>
          <span className="mt-1 block font-mono text-xs text-ink-soft">
            Live scoring, season standings and rotating scorers, for club members.
          </span>
        </Link>

        <Link
          href={`/event/${SAMPLE_EVENT_TOKEN}`}
          className="block border border-hairline bg-card px-5 py-4 transition-colors hover:border-forest"
        >
          <span className="font-display text-lg font-bold">
            One-off outing →
          </span>
          <span className="mt-1 block font-mono text-xs text-ink-soft">
            No account needed. Tap your name and score.
          </span>
        </Link>
      </div>
    </main>
  );
}
