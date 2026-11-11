import { EventAdmin } from "@/components/event/EventAdmin";

/**
 * Organiser controls for one outing, behind its 8-digit PIN.
 *
 * No account here either — the PIN is the credential, exchanged once for an
 * admin token. Every action is checked again in the database, so this page
 * rendering is a convenience, never the boundary.
 */
export default async function EventAdminPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return <EventAdmin token={token} />;
}
