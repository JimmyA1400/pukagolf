import { PlatformAdmin } from "@/components/PlatformAdmin";
import { SiteNav } from "@/components/SiteNav";

/**
 * The platform admin's page: every club, and the means to start a new one.
 * Not under /c/<club>, because it is above all of them.
 *
 * Gated in the database: platform_clubs() and every action here refuse
 * anyone but the platform admin.
 */
export default function Platform() {
  return (
    <>
      <SiteNav />
      <PlatformAdmin />
    </>
  );
}
