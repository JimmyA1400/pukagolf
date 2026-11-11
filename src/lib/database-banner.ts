/**
 * Which database a non-production build is talking to.
 *
 * The multi-course work runs against a separate test project, and a preview
 * deploy pointed at the live one by mistake would let a migration rehearsal
 * write real scores. So every build that isn't production says which database
 * it is on, by the project's own id, and says so loudly unless that build was
 * explicitly marked as the test one.
 *
 * Production shows nothing: players never see this.
 */

export type DatabaseBanner = {
  tone: "test" | "warning";
  text: string;
};

export function databaseBanner({
  vercelEnv,
  supabaseUrl,
  label,
}: {
  /** Vercel's own "production" | "preview" | "development"; unset locally. */
  vercelEnv?: string;
  supabaseUrl?: string;
  /** NEXT_PUBLIC_DATABASE_LABEL: "test" only where the test project is set. */
  label?: string;
}): DatabaseBanner | null {
  if (vercelEnv === "production") return null;

  // No database at all is demo mode, which has its own banner.
  const ref = projectRef(supabaseUrl);
  if (!ref) return null;

  if (label === "test") {
    return {
      tone: "test",
      text: `Test database (${ref}). Nothing here reaches the live site.`,
    };
  }

  return {
    tone: "warning",
    text: `Not marked as the test database (${ref}). This may be live data.`,
  };
}

/** "abcd1234" from https://abcd1234.supabase.co, the part a person recognises. */
function projectRef(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}
