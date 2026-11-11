import { SiteNav } from "@/components/SiteNav";
import { TournamentDetail } from "@/components/TournamentDetail";
import { PukaGolfOnly } from "@/components/PukaGolfOnly";

/** One tournament. `params` is a Promise in Next 16. */
export default async function TournamentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <SiteNav />
      <PukaGolfOnly what="Tournaments">
        <TournamentDetail id={id} />
      </PukaGolfOnly>
    </>
  );
}
