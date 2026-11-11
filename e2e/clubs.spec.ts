import { expect, test } from "@playwright/test";

import { CASEY, leagueTables } from "./fixtures";
import { openLeague } from "./league";
import { mockSupabase } from "./supabase-mock";

/**
 * Club addresses. Everything moved under /c/<club> when there came to be more
 * than one club, and every address that worked before has to keep working:
 * bookmarks, shared links, and the installed app's own home button.
 */
test.describe("club addresses", () => {
  test("a player in one club goes straight from /league to their club's league", async ({
    page,
  }) => {
    await openLeague(page);

    await expect(page).toHaveURL(/\/c\/pukagolf\/league$/);
    await expect(page.getByRole("navigation", { name: "Main" })).toContainText("PukaGolf");
  });

  test("the old addresses lead to PukaGolf's pages", async ({ request }) => {
    for (const [from, to] of [
      ["/league/events", "/c/pukagolf/league/events"],
      ["/league/groups", "/c/pukagolf/league/groups"],
      ["/admin", "/c/pukagolf/admin"],
      ["/outings", "/c/pukagolf/outings"],
      ["/tournaments", "/c/pukagolf/tournaments"],
      ["/charities", "/c/pukagolf/charities"],
    ]) {
      const response = await request.get(from, { maxRedirects: 0 });

      expect(response.status(), from).toBe(307);
      expect(response.headers().location, from).toBe(to);
    }
  });

  test("a club the player isn't in says so, rather than showing an empty league", async ({
    page,
  }) => {
    await mockSupabase(page, {
      user: CASEY,
      tables: leagueTables(),
      rpc: {
        club_public: (args) =>
          args.in_slug === "moose-ridge"
            ? { id: "c1", slug: "moose-ridge", name: "Moose Ridge", status: "active", isDemo: true }
            : null,
      },
    });

    await page.goto("/sign-in");
    await page.getByLabel("Mobile number").fill("2395550132");
    await page.getByLabel("Password").fill("a-good-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");

    await page.goto("/c/moose-ridge/league");
    await expect(page.getByText("You aren't a member of Moose Ridge.")).toBeVisible();

    await page.goto("/c/no-such-club/league");
    await expect(page.getByText("There's no club at this address.")).toBeVisible();
  });
});
