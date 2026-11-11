import { ClubChooser } from "@/components/ClubChooser";
import { SiteNav } from "@/components/SiteNav";
import { DemoLeague } from "@/components/league/DemoLeague";
import { isConfigured } from "@/lib/supabase/client";

/**
 * /league: the way into your club's league.
 *
 * The league itself lives at /c/<club>/league now. This page sends a player in
 * one club straight there and lets a player in several pick, so the address
 * everyone has bookmarked, and the installed app's home button, keep working.
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
      <ClubChooser />
    </>
  );
}
