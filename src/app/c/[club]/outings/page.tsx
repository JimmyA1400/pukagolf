import { redirect } from "next/navigation";

import { EventsAdmin } from "@/components/league/EventsAdmin";
import { PukaGolfOnly } from "@/components/PukaGolfOnly";
import { SiteNav } from "@/components/SiteNav";
import { createClient } from "@/lib/supabase/server";

/**
 * One-off outings: the share-link kind.
 *
 * Its own tab, apart from the league's events, because the two are different
 * days. An outing is a link handed to whoever is playing — the token is the
 * credential, nobody needs an account, and it never touches the season. A
 * league event has an invited roster and reaches the players' profiles.
 *
 * They share the events table and the format registry. What differs is who
 * can get in, and that is enough to keep them on separate tabs.
 */
export default async function Outings() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

  return (
    <>
      <SiteNav />
      <PukaGolfOnly what="Outings">
        <EventsAdmin />
      </PukaGolfOnly>
    </>
  );
}
