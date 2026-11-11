import { redirect } from "next/navigation";

import { PukaGolfOnly } from "@/components/PukaGolfOnly";
import { EventCreator } from "@/components/league/EventCreator";
import { createClient } from "@/lib/supabase/server";

/**
 * Create a one-off outing. Admin only.
 *
 * Checked on the server so the page never renders for a non-admin. The RPC
 * checks again anyway — this is convenience, not the security boundary.
 */
export default async function NewEvent({ params }: PageProps<"/c/[club]/outings/new">) {
  const { club } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_admin) redirect(`/c/${club}/league`);

  return (
    <PukaGolfOnly what="Outings">
      <EventCreator />
    </PukaGolfOnly>
  );
}
