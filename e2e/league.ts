import { expect, type Page } from "@playwright/test";

import { CASEY, leagueTables, season } from "./fixtures";
import { mockSupabase, type MockOptions } from "./supabase-mock";

/** Sign in as Casey through the real form, then open the league. */
export async function openLeague(page: Page, options: Partial<MockOptions> = {}) {
  const supabase = await mockSupabase(page, {
    user: CASEY,
    tables: leagueTables(),
    rpc: { league_season: () => season() },
    ...options,
  });

  await page.goto("/sign-in");
  await page.getByLabel("Mobile number").fill("2395550132");
  await page.getByLabel("Password").fill("a-good-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");

  await page.goto("/league");
  // The scoring pad is the last thing to arrive, and it is there whether the
  // week is kept card by card or as one card for the whole side.
  await expect(page.getByRole("region", { name: /^Scoring / })).toBeVisible();

  return supabase;
}

export const leaderboard = (page: Page) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Leaderboard", exact: true }) });

/** A leaderboard row's Score cell: position, player, then score. */
export const scoreOf = (page: Page, name: string) =>
  leaderboard(page).getByRole("row", { name: new RegExp(name) }).getByRole("cell").nth(2);

/** Score a hole on the big-button pad, the way a player would. */
export async function enterHole(page: Page, hole: number, strokes: number) {
  const pad = page.getByRole("region", { name: /^Scoring / });

  await pad.getByRole("button", { name: new RegExp(`^Hole ${hole}\\b`) }).click();

  const shown = pad.getByRole("status", { name: "Strokes" });
  let value = Number(await shown.textContent());
  while (value < strokes) {
    await pad.getByRole("button", { name: "One more stroke" }).click();
    value += 1;
  }
  while (value > strokes) {
    await pad.getByRole("button", { name: "One fewer stroke" }).click();
    value -= 1;
  }
  await expect(shown).toHaveText(String(strokes));

  await pad.getByRole("button", { name: /^(Save|Update) / }).click();
}
