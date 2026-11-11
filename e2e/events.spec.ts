import { expect, test } from "@playwright/test";

import { CASEY, leagueTables } from "./fixtures";
import { openLeague } from "./league";

/**
 * Outings and events are two different days, and the app says so in its
 * navigation: an outing is reached by a link anyone can hold, an event by
 * being invited. They used to be listed on one page, which meant checking
 * which kind you were looking at every time.
 */
test.describe("outings and events are kept apart", () => {
  /** Casey, but running the league. */
  const asAdmin = () => {
    const tables = leagueTables();
    tables.profiles = tables.profiles.map((p) =>
      p.id === CASEY.id ? { ...p, is_admin: true } : p,
    );

    return tables;
  };

  test("an admin gets an Outings tab; events stay inside the League tab", async ({
    page,
  }) => {
    await openLeague(page, { tables: asAdmin() });

    const nav = page.getByRole("navigation", { name: "Main" });

    await expect(nav.getByRole("link", { name: "Outings" })).toHaveAttribute(
      "href",
      "/c/pukagolf/outings",
    );
    // Events are deliberately not a tab: they belong to the league, and an
    // admin sets one up from inside it.
    await expect(nav.getByRole("link", { name: "Events", exact: true })).toHaveCount(0);
  });

  test("the league offers both, each to its own place", async ({ page }) => {
    await openLeague(page, { tables: asAdmin() });

    await expect(page.getByRole("link", { name: "League events" })).toHaveAttribute(
      "href",
      "/c/pukagolf/league/events",
    );
    await expect(page.getByRole("link", { name: "All outings" })).toHaveAttribute(
      "href",
      "/c/pukagolf/outings",
    );
    await expect(page.getByRole("link", { name: "New outing" })).toHaveAttribute(
      "href",
      "/c/pukagolf/outings/new",
    );
  });

  /**
   * The old address has to be sent on rather than left to resolve: it now
   * matches /league/events/[id], so a stale bookmark would look up an event
   * called "new" instead of opening the form.
   */
  test("the old new-outing address still lands on the form", async ({ request }) => {
    const response = await request.get("/league/events/new", { maxRedirects: 0 });

    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe("/c/pukagolf/outings/new");
  });

  test("a player who doesn't run the league sees neither", async ({ page }) => {
    await openLeague(page);

    const nav = page.getByRole("navigation", { name: "Main" });

    // The list of outings is every share token the league has issued, so the
    // tab would only lead to a refusal.
    await expect(nav.getByRole("link", { name: "Outings" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "All outings" })).toHaveCount(0);
  });
});
