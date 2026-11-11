import { createBrowserClient } from "@supabase/ssr";

import { withSkewRetry } from "./skew-retry";
import type { Database } from "./types";

/**
 * Supabase client for the browser.
 *
 * Cookie handling is deliberately left to the library — it falls back to
 * `document.cookie`, which is what we want. The session must live in cookies
 * rather than localStorage so server rendering can read it too.
 *
 * Every request goes through withSkewRetry, which rides out the moment after
 * a token refresh when the database refuses the new token as issued in the
 * future.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { fetch: withSkewRetry() } },
  );
}

/** True when the project has been configured. Lets the UI explain itself. */
export const isConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
