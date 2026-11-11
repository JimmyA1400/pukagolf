import { ProfilePage } from "@/components/ProfilePage";
import { SiteNav } from "@/components/SiteNav";

/**
 * The signed-in player's own profile: their details, their calculated
 * handicap, recent scores and every upcoming round they can answer for.
 */
export default function Profile() {
  return (
    <>
      <SiteNav />
      <ProfilePage />
    </>
  );
}
