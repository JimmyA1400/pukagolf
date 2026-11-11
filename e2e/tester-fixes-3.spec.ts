import { expect, test, type Page } from "@playwright/test";

import { CASEY, leagueTables, RILEY_ID, SATURDAY, season, TAYLOR_ID, THIS_WEEK } from "./fixtures";
import { leaderboard, openLeague } from "./league";
import type { Row } from "./supabase-mock";

/** The testers' third run, fixed. */

const asAdmin = (tables: Record<string, Row[]>): Record<string, Row[]> => ({
  ...tables,
  profiles: tables.profiles.map((p) => (p.id === CASEY.id ? { ...p, is_admin: true } : p)),
});

const card = (playerId: string, strokes: number[]) =>
  strokes.map((s, i) => ({
    round_id: THIS_WEEK,
    player_id: playerId,
    hole: i + 1,
    strokes: s,
    entered_by: CASEY.id,
  }));

const pad = (page: Page) => page.getByRole("region", { name: /^Scoring / });

test.describe("tee times", () => {
  // A phone set to Tokyo still reads the club's own clock.
  test.use({ timezoneId: "Asia/Tokyo" });

  test("read on the club's clock, whatever zone the phone is in", async ({ page }) => {
    await openLeague(page);
    // 13:00 UTC is 9:00 AM in New York, where the club is.
    await expect(page.getByText(/Group 1 · 9:00\sAM/).first()).toBeVisible();
    await expect(page.getByText(/10:00\sPM/)).toHaveCount(0);
  });
});

test.describe("the other leagues", () => {
  const choices = [
    { id: SATURDAY, name: "Saturday League", status: null },
    { id: "l-sunday", name: "Sunday League", status: null, day: "Sunday", firstTee: "08:00", course: "Pine Hills" },
    { id: "l-twilight", name: "Twilight", status: "requested", day: "Wednesday", firstTee: "17:30", course: null },
  ];

  test("say when and where they play, and what asking means", async ({ page }) => {
    await openLeague(page, { rpc: { league_season: () => season(), club_league_choices: () => choices } });

    await expect(page.getByText("Sundays · first tee 8:00 AM · Pine Hills")).toBeVisible();
    await expect(page.getByText("Wednesdays · first tee 5:30 PM")).toBeVisible();
    await expect(page.getByText(/Asked\. The pro shop will add you/)).toBeVisible();
  });

  test("leave out the league being looked at, and let an admin add themselves", async ({ page }) => {
    await openLeague(page, {
      tables: asAdmin(leagueTables()),
      rpc: { league_season: () => season(), club_league_choices: () => choices },
    });

    const others = page.getByRole("list").filter({ has: page.getByText("Sunday League") });
    await expect(others.getByText("Saturday League")).toHaveCount(0);
    await expect(others.getByRole("button", { name: "Add me" })).toHaveCount(1);
    await expect(others.getByRole("button", { name: "Ask to play" })).toHaveCount(0);
  });
});

test.describe("a week still being set up", () => {
  test("can't be scored, and says so", async ({ page }) => {
    const tables = leagueTables();
    tables.rounds[0].status = "setup";
    await openLeague(page, { tables }).catch(() => {});

    await expect(page.getByText(/still being set up, so it hasn.t started and\s+can.t be scored yet/)).toBeVisible();
    await expect(pad(page)).toHaveCount(0);
  });
});

test.describe("a finished card", () => {
  test("says the card is complete, not final, and points to signing", async ({ page }) => {
    const tables = leagueTables();
    tables.scores = card(RILEY_ID, [4, 4, 4, 4, 4, 4, 4, 4, 4]);
    await openLeague(page, { tables });

    await expect(pad(page).getByText("Card complete")).toBeVisible();
    await expect(pad(page).getByText(/All 9 holes are in/)).toBeVisible();
    await expect(pad(page).getByText("Final", { exact: true })).toHaveCount(0);
  });
});

test.describe("a card kept by its own player", () => {
  test("is flagged on the leaderboard", async ({ page }) => {
    const tables = leagueTables();
    tables.scores = card(RILEY_ID, [4, 4, 4]).map((s) => ({ ...s, entered_by: RILEY_ID }));
    await openLeague(page, { tables });

    await expect(
      leaderboard(page).getByText("Kept own card").filter({ visible: true }).first(),
    ).toBeVisible();
  });
});

test.describe("a locked card", () => {
  test("shows its scores before the admin decides to change it", async ({ page }) => {
    const tables = asAdmin(leagueTables({ twoGroups: true }));
    tables.rounds[0].status = "final";
    tables.scores = card(TAYLOR_ID, [5, 5, 4]);
    await openLeague(page, { tables }).catch(() => {});

    await page.getByRole("combobox", { name: "Choose a player to edit" }).selectOption({ label: "Taylor Sample" });
    const cards = page.getByRole("tabpanel", { name: "Scorecards" });
    await expect(cards.getByRole("heading", { name: "Taylor Sample" })).toBeVisible();
    await expect(page.getByText(/press .Change it anyway. and give a reason/)).toBeVisible();
    await expect(page.getByText(/Change a hole above/)).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the season table fits without scrolling sideways", async ({ page }) => {
    await openLeague(page);
    await page.getByRole("tab", { name: "Standings", exact: true }).click();

    const table = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Pts" }) });
    await expect(table).toBeVisible();
    const overflow = await table.evaluate((el) => el.scrollWidth - (el.parentElement?.clientWidth ?? 0));
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("the card's total stays on screen in Sunlight mode", async ({ page }) => {
    const tables = leagueTables();
    tables.scores = card(CASEY.id, [4, 4, 4]);
    await openLeague(page, { tables });
    await page.getByRole("button", { name: "Sunlight" }).click();

    const total = page.getByRole("columnheader", { name: /^total$/i }).first();
    await expect(total).toBeVisible();
    const box = await total.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
  });
});
