"use client";

import { useEffect } from "react";

import { logClientError } from "@/lib/client-errors";

/**
 * The last resort, for an error in the root layout itself.
 *
 * It replaces the whole document, so the site's stylesheet and fonts are not
 * loaded here; the few styles it needs are inline, in the clubhouse palette.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    logClientError("boundary", error, error.digest);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#faf7ec",
          color: "#1c1b18",
          fontFamily: "ui-monospace, Menlo, monospace",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <main style={{ maxWidth: "28rem" }}>
          <h1 style={{ fontFamily: "Georgia, serif", fontSize: "2rem", margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ lineHeight: 1.6 }}>
            PukaGolf hit an error. It&apos;s been recorded.
          </p>
          {/*
            A plain link on purpose: the root layout has just crashed, and a
            full page load starts the app again from scratch, where a
            client-side navigation would carry on inside the broken one.
          */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" style={{ color: "#1d3521" }}>
            Back to PukaGolf
          </a>
        </main>
      </body>
    </html>
  );
}
