import { CharitiesPage } from "@/components/CharitiesPage";
import { PukaGolfOnly } from "@/components/PukaGolfOnly";
import { SiteNav } from "@/components/SiteNav";

/** Which charities the league supports, and what each event raised. */
export default function Charities() {
  return (
    <>
      <SiteNav />
      <PukaGolfOnly what="Charities">
        <CharitiesPage />
      </PukaGolfOnly>
    </>
  );
}
