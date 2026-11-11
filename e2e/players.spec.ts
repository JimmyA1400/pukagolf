import { expect, test } from "@playwright/test";

import { CASEY, leagueTables, season } from "./fixtures";
import { openLeague } from "./league";
import { mockSupabase } from "./supabase-mock";

test.describe("for players", () => {
  test("a forgotten password is reset by text", async ({ page }) => {
    const supabase = await mockSupabase(page, {
      user: CASEY,
      tables: leagueTables(),
      rpc: { league_season: () => season() },
    });

    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    // Sign-in has a "Mobile number" box too; wait for the reset page's own.
    await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();

    await page.getByLabel("Mobile number").fill("2395550132");
    await page.getByRole("button", { name: "Text me a code", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Enter the code" })).toBeVisible();
    // Signs in only: an unknown number must never become a new account.
    expect(supabase.callsTo("POST", "/auth/v1/otp")[0]?.body).toMatchObject({
      phone: "+12395550132",
      create_user: false,
    });

    await page.getByLabel("Code", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();

    await page.getByLabel("New password", { exact: true }).fill("a-new-password");
    await page.getByLabel("New password again", { exact: true }).fill("a-new-password");
    await page.getByRole("button", { name: "Save new password", exact: true }).click();

    await page.waitForURL((url) => url.pathname === "/league");
    expect(supabase.callsTo("PUT", "/auth/v1/user")[0]?.body).toMatchObject({
      password: "a-new-password",
    });
  });

  test("My week shows the group, the tee time and whose card you keep", async ({ page }) => {
    await openLeague(page);

    const card = page.getByRole("region", { name: "Your week" });
    await expect(card).toContainText("Group 1 · 9:00 AM");
    await expect(card).toContainText("With Riley M.");
    await expect(card).toContainText("You’re keeping Riley M.’s card.");
    await expect(card).toContainText("Riley M. keeps yours.");
  });

  test("sunlight mode stays on for this phone", async ({ page }) => {
    await openLeague(page);

    await page.getByRole("button", { name: "Sunlight" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-sunlight", "");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-sunlight", "");
    await expect(page.getByRole("button", { name: "Sunlight" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
