import { SiteNav } from "@/components/SiteNav";
import { PublicProfile } from "@/components/PublicProfile";

/**
 * Another player's record. `params` is a Promise in Next 16.
 */
export default async function PlayerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <SiteNav />
      <PublicProfile playerId={id} />
    </>
  );
}
