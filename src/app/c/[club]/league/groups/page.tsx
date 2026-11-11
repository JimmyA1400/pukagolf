import { GroupsEditor } from "@/components/league/GroupsEditor";
import { SiteNav } from "@/components/SiteNav";

/**
 * This week's groups and tee times, for an admin: built from RSVPs or
 * arranged by hand. The admin_* functions behind it refuse anyone else.
 */
export default function Groups() {
  return (
    <>
      <SiteNav />
      <GroupsEditor />
    </>
  );
}
