import { ClubAdminPage } from "@/components/ClubAdminPage";
import { SiteNav } from "@/components/SiteNav";

/**
 * A club's admin page: its members, staff, leagues and join link, for any
 * club's admins; and, on PukaGolf's, the Saturday League's weeks, rules and
 * seasons below, until those belong to every league.
 *
 * Gated in the database, not here: every action is a function that refuses
 * anyone but an admin of this club, and the page shows nothing it can't load.
 */
export default function Admin() {
  return (
    <>
      <SiteNav />
      <ClubAdminPage />
    </>
  );
}
