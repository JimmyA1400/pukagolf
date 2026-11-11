import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "./types";

/**
 * Supabase client for server components, route handlers and server actions.
 *
 * `cookies()` is async-only in Next 16 — the synchronous form most published
 * examples still use was removed, not deprecated.
 *
 * A fresh client per request, never shared: a reused client would leak one
 * request's session into another.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server components can't set cookies. Harmless: proxy.ts refreshes
            // the session on every request, so the write isn't lost.
          }
        },
      },
    },
  );
}
