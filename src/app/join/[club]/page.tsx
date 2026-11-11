import { JoinClub } from "@/components/JoinClub";

/**
 * A club's front door: what its QR code and link open.
 *
 * Outside /c/<club> on purpose. Everything under there is for members, and the
 * whole point of this page is the people who aren't one yet.
 */
export default async function JoinPage({ params }: PageProps<"/join/[club]">) {
  const { club } = await params;

  return <JoinClub slug={club} />;
}
