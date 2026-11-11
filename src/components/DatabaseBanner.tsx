import { databaseBanner } from "@/lib/database-banner";

/**
 * A strip across the top of every page on a preview or local build, naming
 * the database. See src/lib/database-banner.ts for why.
 *
 * The values are inlined at build time, so a preview's banner always matches
 * the database that build was actually given.
 */
export function DatabaseBanner() {
  const banner = databaseBanner({
    // Rendered on the server, so Vercel's own VERCEL_ENV is there even if the
    // public copy of it isn't exposed: production must never show the strip.
    vercelEnv: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    label: process.env.NEXT_PUBLIC_DATABASE_LABEL,
  });

  if (!banner) return null;

  return (
    // Not role="status": that is for messages a page announces as they
    // change, and pages already use it for theirs.
    <aside
      aria-label="Database"
      className={`meta px-4 py-1 text-center text-xs ${
        banner.tone === "test" ? "bg-sand text-forest-deep" : "bg-clay text-cream"
      }`}
    >
      {banner.text}
    </aside>
  );
}
