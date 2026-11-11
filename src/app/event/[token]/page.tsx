import { EventScoring } from "@/components/event/EventScoring";

/**
 * A one-off outing. No account, no login, no email.
 *
 * The token in the URL is the credential — anyone holding the link can score.
 * `params` is a Promise in Next 16.
 */
export default async function EventPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return <EventScoring token={token} />;
}
