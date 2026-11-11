"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, and only in production.
 *
 * In development a worker that caches build output serves yesterday's chunks
 * after every edit, so this also tears down any worker that a previous
 * production visit to the same origin left behind — otherwise `localhost:3000`
 * inherits one from a `next build && next start` and the cause is very hard to
 * see from inside the app.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker
        .getRegistrations()
        .then((all) => all.forEach((one) => void one.unregister()));

      return;
    }

    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js");

        // A deploy while the app is open leaves the new worker waiting behind
        // the old one. Scoring is live, so take the update now rather than
        // whenever every tab happens to close.
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;

          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              installing.postMessage("skip-waiting");
            }
          });
        });
      } catch {
        // An unregistrable worker is not a reason to break the page.
      }
    })();
  }, []);

  return null;
}
