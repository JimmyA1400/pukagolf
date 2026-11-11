import type { Metadata } from "next";

import { PrintSheets } from "@/components/league/PrintSheets";

export const metadata: Metadata = {
  title: "Tee sheet and scorecards · PukaGolf",
};

/** This week on paper. Needs a signed-in player, like the league page. */
export default function PrintPage() {
  return <PrintSheets />;
}
