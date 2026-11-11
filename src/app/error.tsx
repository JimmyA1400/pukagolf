"use client";

import Link from "next/link";
import { useEffect } from "react";

import { logClientError } from "@/lib/client-errors";

/**
 * What a page shows when it crashes, instead of a blank screen.
 *
 * The error is reported to the site's error log, so the owner sees it on
 * /admin without anyone having to describe it.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logClientError("boundary", error, error.digest);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center p-6 sm:p-8">
      <p className="meta">PukaGolf</p>
      <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-3 font-display text-lg">
        This page hit an error. It&apos;s been recorded, so there&apos;s no
        need to report it.
      </p>

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="min-h-12 flex-1 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase"
        >
          Try again
        </button>
        <Link
          href="/league"
          className="min-h-12 flex-1 border border-hairline bg-card px-4 py-3.5 text-center font-mono text-xs tracking-wider uppercase hover:border-forest"
        >
          The league
        </Link>
      </div>
    </main>
  );
}
