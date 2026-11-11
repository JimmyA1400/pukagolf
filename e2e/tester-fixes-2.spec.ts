import { expect, test, type Page } from "@playwright/test";

import {
  CASEY,
  JORDAN_ID,
  leagueTables,
  RILEY_ID,
  SATURDAY,
  season,
  TAYLOR_ID,
  THIS_WEEK,
} from "./fixtures";
import { leaderboard, openLeague } from "./league";
import type { Row } from "./supabase-mock";

/** The testers' second run, fixed. */

const asAdmin = (tables: Record<string, Row[]>): Record<string, Row[]> => ({
  ...tables,
  profiles: tables.profiles.map((p) => (p.id === CASEY.id ? { ...p, is_admin: true } : p)),
});

const fixAnyCard = (page: Page) => page.getByRole("combobox", { name: "Choose a player to edit" });

const card = (playerId: string, strokes: number[]) =>
  strokes.map((s, i) => ({ round_id: THIS_WEEK, player_id: playerId, hole: i + 1, strokes: s }));

test.describe("a final week's cards", () => {
  const finalWeek = () => {
    const tables = asAdmin(leagueTables({ twoGroups: true }));
    tables.rounds[0].status = "final";
    tables.scores = [...card(TAYLOR_ID, [5, 5, 4]), ...card(JORDAN_ID, [4, 4, 4])];
    return tables;
  };

  test("say the week is final, never that the group signed them", async ({ page }) => {
    await openLeague(page, { tables: finalWeek() }).catch(() => {});
    // A final week has no pad to wait for; the admin's card picker is there.
    await expect(fixAnyCard(page)).toBeVisible();

    await fixAnyCard(page).selectOption({ label: "Taylor Sample" });
    const warning = page.getByRole("alert").filter({ hasText: "Why is the card changing?" });
    await expect(warning).toContainText("Nobody signed Taylor Sample’s card.");
    await expect(warning).toContainText("The week is marked final");
    await expect(warning).not.toContainText("agreed");

    // Nothing to unlock card by card, and the page says what to do instead.
    await expect(page.getByRole("button", { name: /Unlock this card|sign-off/ })).toHaveCount(0);
    await expect(page.getByText(/set the week back to Live on the admin page/)).toBeVisible();
  });

  test("show one reason box, for the card picked", async ({ page }) => {
    await openLeague(page, { tables: finalWeek(), rpc: { league_season: () => season(), card_history: () => [] } }).catch(
      () => {},
    );

    await fixAnyCard(page).selectOption({ label: "Taylor Sample" });
    await page.getByRole("button", { name: "The card’s history" }).click();
    await fixAnyCard(page).selectOption({ label: "Jordan Stub" });

    await expect(page.getByRole("button", { name: "Change it anyway" })).toHaveCount(1);
    await expect(page.getByText(/Nobody signed Jordan Stub’s card/)).toBeVisible();
    await expect(page.getByText(/Nobody signed Taylor Sample’s card/)).toHaveCount(0);
  });
});

test.describe("the pad after a correction", () => {
  test("goes back to the hole you were on", async ({ page }) => {
    const tables = leagueTables();
    tables.scores = card(RILEY_ID, [4, 4, 4]);
    await openLeague(page, { tables });

    const pad = page.getByRole("region", { name: /^Scoring / });
    await expect(pad.getByText("Hole 4", { exact: true })).toBeVisible();

    await pad.getByRole("button", { name: /^Hole 1\b/ }).click();
    await pad.getByRole("button", { name: "One more stroke" }).click();
    await pad.getByRole("button", { name: "Update 5 · back to hole 4" }).click();

    await expect(pad.getByText("Hole 4", { exact: true })).toBeVisible();
  });
});

test.describe("ties", () => {
  test("level on the score share a place, whatever the holes played", async ({ page }) => {
    const tables = leagueTables({ twoGroups: true });
    // Riley -2 thru 4, Taylor -2 thru 2.
    tables.scores = [...card(RILEY_ID, [3, 3, 4, 4]), ...card(TAYLOR_ID, [3, 3])];
    await openLeague(page, { tables });

    const place = (name: string) =>
      leaderboard(page).getByRole("row", { name: new RegExp(name) }).getByRole("cell").first();
    await expect(place("Riley Mock")).toHaveText("T1");
    await expect(place("Taylor Sample")).toHaveText("T1");
  });
});

test.describe("the winner at the end only", () => {
  test("names nobody as leading while the week is played", async ({ page }) => {
    const tables = leagueTables();
    tables.scores = card(RILEY_ID, [3, 4, 4]);
    await openLeague(page, { tables });

    await expect(page.getByText(/Current leader/)).toHaveCount(0);
  });

  test("a league that shows the leader marks it provisional", async ({ page }) => {
    const tables = leagueTables();
    tables.scores = card(RILEY_ID, [3, 4, 4]);
    tables.league_rules = [{ league_id: SATURDAY, scoring_mode: "partner", standings_count: "live" }];
    await openLeague(page, { tables });

    await expect(page.getByText("Current leader · provisional")).toBeVisible();
  });
});

test.describe("making a week final", () => {
  test("asks first, and says which cards aren't finished", async ({ page }) => {
    const tables = asAdmin(leagueTables());
    tables.scores = card(RILEY_ID, [4, 4, 4, 4]);
    const supabase = await openLeague(page, {
      tables,
      rpc: {
        league_season: () => season(),
        round_completion: () => ({
          holeCount: 9,
          players: [
            { playerId: CASEY.id, name: "Casey Tester", posted: 9 },
            { playerId: RILEY_ID, name: "Riley Mock", posted: 4 },
          ],
        }),
        complete_round: () => ({}),
      },
    });

    await page.getByRole("tab", { name: "19th Hole", exact: true }).click();
    await page.getByRole("button", { name: /Complete anyway/ }).click();

    const ask = page.getByRole("alert").filter({ hasText: "Make Week 2 final?" });
    await expect(ask).toContainText("One card isn't finished: Riley Mock (5 holes left). It won't earn points.");
    expect(supabase.callsTo("POST", "/rest/v1/rpc/complete_round")).toHaveLength(0);

    await ask.getByRole("button", { name: "Make it final anyway" }).click();
    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/rpc/complete_round").length).toBe(1);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/complete_round")[0].body).toEqual({
      in_round_id: THIS_WEEK,
      force: true,
    });
  });
});
