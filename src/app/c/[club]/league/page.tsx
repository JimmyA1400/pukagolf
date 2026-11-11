import { SiteNav } from "@/components/SiteNav";
import { DemoLeague } from "@/components/league/DemoLeague";
import { LiveLeague } from "@/components/league/LiveLeague";
import { isConfigured } from "@/lib/supabase/client";

/**
 * The weekly league. Requires an account: real profiles, season standings, and
 * the scorer rotation.
 *
 * One-off outings live at /event/[token] instead, with no login at all.
 */
export default function League() {
  if (!isConfigured) {
    return (
      <>
        <p className="bg-clay px-5 py-2 text-center font-mono text-xs text-cream sm:px-8">
          Demo mode — nothing saves. Add your Supabase keys to .env.local to go
          live.
        </p>
        <SiteNav />
        <DemoLeague />
      </>
    );
  }

  return (
    <>
      <SiteNav />
      <LiveLeague />
    </>
  );
}
