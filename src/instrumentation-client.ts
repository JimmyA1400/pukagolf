import { logClientError } from "@/lib/client-errors";

/*
  Runs before the app becomes interactive, so it catches errors that happen
  while the page is still starting up, not just ones after React has taken
  over. React's own render errors reach app/error.tsx and app/global-error.tsx,
  which report them there.
*/

try {
  window.addEventListener("error", (event) => {
    // A failed image or script load fires this too, with no error attached
    // and nothing in the message worth recording.
    if (!event.error && !event.message) return;

    logClientError("error", event.error ?? event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    logClientError("rejection", event.reason);
  });
} catch {
  // Never break start-up over monitoring.
}
