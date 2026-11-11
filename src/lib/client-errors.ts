import { createClient, isConfigured } from "./supabase/client";

/**
 * Report an error from the browser to the site's own error log.
 *
 * Errors used to live only in the player's console, where nobody would ever
 * see them. This sends them to report_client_error(), which the owner reads
 * on /admin.
 *
 * Never throws and never waits: reporting an error must not become the error.
 */

export type ClientErrorKind = "error" | "rejection" | "boundary";

/** One bad render can fire the same error dozens of times a second. */
const MAX_REPORTS_PER_PAGE = 10;

const reported = new Set<string>();
let sent = 0;

export function logClientError(
  kind: ClientErrorKind,
  error: unknown,
  digest?: string,
): void {
  try {
    if (!isConfigured || typeof window === "undefined") return;

    const message = describe(error);

    // Cross-origin script failures arrive stripped to this; there is nothing
    // in them to act on.
    if (message === "Script error.") return;

    const key = `${kind}:${message}`;
    if (reported.has(key) || sent >= MAX_REPORTS_PER_PAGE) return;

    reported.add(key);
    sent += 1;

    const stack = error instanceof Error ? (error.stack ?? null) : null;

    void createClient()
      .rpc("report_client_error", {
        in_kind: kind,
        in_message: message.slice(0, 500),
        in_stack: stack ? stack.slice(0, 4000) : null,
        in_path: safePath(window.location.pathname),
        in_user_agent: navigator.userAgent.slice(0, 300),
        in_digest: digest ?? null,
      })
      .then(
        () => undefined,
        () => undefined,
      );
  } catch {
    // Monitoring that can break the page is worse than none.
  }
}

/**
 * The page's path with credentials taken out.
 *
 * An outing's link IS its access, and it sits in the path, so logging the
 * path as-is would put a working invite in the error log. The query string
 * is left out entirely for the same reason.
 */
export function safePath(pathname: string): string {
  return pathname.replace(/\/event\/[^/]+/, "/event/[token]").slice(0, 500);
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Error";
  if (typeof error === "string") return error || "(empty message)";

  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
