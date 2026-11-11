import { SiteNav } from "@/components/SiteNav";
import { TournamentsPage } from "@/components/TournamentsPage";
import { PukaGolfOnly } from "@/components/PukaGolfOnly";

/** The league's tournament schedule, with entries and past results. */
export default function Tournaments() {
  return (
    <>
      <SiteNav />
      <PukaGolfOnly what="Tournaments">
        <TournamentsPage />
      </PukaGolfOnly>
    </>
  );
}
