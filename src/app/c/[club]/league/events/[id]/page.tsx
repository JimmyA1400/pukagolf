import { redirect } from "next/navigation";

import { EventSetup } from "@/components/league/EventSetup";
import { SiteNav } from "@/components/SiteNav";
import { createClient } from "@/lib/supabase/server";

/**
 * Setting up one league event.
 *
 * A league event has no anonymous way in — event_state() refuses one outright
 * — so this page is behind a session. The RPCs check again; this is
 * convenience, not the security boundary.
 */
export default async function LeagueEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

  return (
    <>
      <SiteNav />
      <EventSetup eventId={id} />
    </>
  );
}
