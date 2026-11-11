import { redirect } from "next/navigation";

import { LeagueEvents } from "@/components/league/LeagueEvents";
import { SiteNav } from "@/components/SiteNav";
import { createClient } from "@/lib/supabase/server";

/**
 * Events inside the league.
 *
 * Outings used to be listed here too, and the two read as one pile. They are
 * on the Outings tab now: an outing is reached by its link, an event by being
 * invited, and a page that mixes them makes the admin check which kind they
 * are looking at every time.
 */
export default async function Events() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

  return (
    <>
      <SiteNav />
      <div className="mx-auto w-full max-w-3xl p-5 sm:p-8">
        <LeagueEvents />
      </div>
    </>
  );
}
