import { expect, test, type Page } from "@playwright/test";

import {
  CASEY,
  leagueTables,
  PUKAGOLF,
  RILEY_ID,
  SATURDAY,
  season,
  TAYLOR_ID,
  THIS_WEEK,
} from "./fixtures";
import { enterHole, openLeague } from "./league";
import type { Row } from "./supabase-mock";

/**
 * What the Practice Ridge testers found, fixed. Each test is one of their
 * findings, played the way they played it.
 */

const SUNDAY = "b0000000-0000-4000-8000-000000000002";

/** The fixture league, with Casey as the club's admin. */
const asAdmin = (tables = leagueTables()): Record<string, Row[]> => ({
  ...tables,
  profiles: tables.profiles.map((p) => (p.id === CASEY.id ? { ...p, is_admin: true } : p)),
});

const scoreWrites = (supabase: Awaited<ReturnType<typeof openLeague>>) =>
  supabase.callsTo("POST", "/rest/v1/scores");

const fixAnyCard = (page: Page) => page.getByRole("combobox", { name: "Choose a player to edit" });

test.describe("a card whose keeper has no login", () => {
  test("the player keeps their own card too, and is told why", async ({ page }) => {
    // Riley keeps Casey's card, and has no login.
    const supabase = await openLeague(page, {
      rpc: { league_season: () => season(), round_players_without_login: () => [RILEY_ID] },
    });

    await expect(page.getByText(/keeps your card but has no login, so you keep your own/)).toBeVisible();

    await page.getByRole("group", { name: "Whose card" }).getByRole("button", { name: "You" }).click();
    await enterHole(page, 1, 4);

    await expect.poll(() => scoreWrites(supabase).length).toBe(1);
    expect(scoreWrites(supabase)[0].body).toMatchObject({ player_id: CASEY.id, hole: 1, strokes: 4 });
  });

  test("with a keeper who can sign in, your own card says why it's read-only", async ({ page }) => {
    await openLeague(page);

    await expect(page.getByText(/so every score is written down by someone else/)).toBeVisible();
    await expect(page.getByRole("group", { name: "Whose card" })).toHaveCount(0);
  });

  test("the pad says why later holes wait", async ({ page }) => {
    await openLeague(page);

    await expect(page.getByText("Holes go in order, the way they’re played: save hole 1")).toBeVisible();
  });
});

test.describe("an admin's own card", () => {
  // Round 5: it's in the list, last, so its sign-off can be taken back, but
  // its scores can't be entered from there.
  test("is in Fix any card, read only, which starts with nobody picked", async ({ page }) => {
    await openLeague(page, { tables: asAdmin() });

    const picker = fixAnyCard(page);
    await expect(picker).toHaveValue("");
    await expect(picker.getByRole("option")).toHaveText(["Pick a card…", /Riley/, "You (your own card)"]);

    await picker.selectOption({ label: "You (your own card)" });
    await expect(page.getByText(/you\s+can.t enter or change them from here/)).toBeVisible();
  });
});

test.describe("changing a signed-off card", () => {
  test("warns, asks why, and sends the reason with the change", async ({ page }) => {
    // Taylor, in the group behind, has signed off.
    const tables = asAdmin(leagueTables({ twoGroups: true }));
    tables.scores = [1, 2].map((hole) => ({ round_id: THIS_WEEK, player_id: TAYLOR_ID, hole, strokes: 5 }));
    tables.card_locks = [
      { round_id: THIS_WEEK, player_id: TAYLOR_ID, locked_at: "2026-09-14T17:00:00Z", locked_by: CASEY.id },
    ];

    const supabase = await openLeague(page, {
      tables,
      rpc: { league_season: () => season(), admin_fix_signed_score: () => null },
    });

    await fixAnyCard(page).selectOption({ label: "Taylor Sample" });
    await expect(page.getByText(/card was signed off by Casey Tester: the group agreed these scores/)).toBeVisible();

    const anyway = page.getByRole("button", { name: "Change it anyway" });
    await expect(anyway).toBeDisabled();
    await page.getByLabel("Why is the card changing?").fill("Hole 2 was a 4, the group agrees");
    await anyway.click();

    const hole2 = page.getByRole("textbox", { name: "Hole 2, par 4" });
    await hole2.fill("4");
    await hole2.press("Enter");

    const fixes = () => supabase.callsTo("POST", "/rest/v1/rpc/admin_fix_signed_score");
    await expect.poll(() => fixes().length).toBe(1);
    expect(fixes()[0].body).toEqual({
      in_round_id: THIS_WEEK,
      in_player_id: TAYLOR_ID,
      in_hole: 2,
      in_strokes: 4,
      in_reason: "Hole 2 was a 4, the group agrees",
    });
    // Never straight to the scores table, which would refuse it anyway.
    expect(scoreWrites(supabase)).toHaveLength(0);
  });
});

test.describe("the leaderboard on a phone", () => {
  test("shows place, name and score with nothing off the edge", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const tables = leagueTables();
    tables.scores = [1, 2, 3].map((hole) => ({ round_id: THIS_WEEK, player_id: RILEY_ID, hole, strokes: 5 }));
    await openLeague(page, { tables });

    const board = page.getByRole("list", { name: "Leaderboard" });
    const riley = board.getByRole("listitem").filter({ hasText: "Riley" });
    await expect(riley).toContainText("+3");
    await expect(page.getByRole("table").filter({ hasText: "Thru" })).toBeHidden();

    const box = await riley.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // The card hole by hole is a tap away.
    await riley.getByText("Riley").click();
    await expect(riley.getByText("5").first()).toBeVisible();
  });
});

test.describe("asking for another league", () => {
  const twoLeagues = () => ({
    my_clubs: () => [
      {
        id: PUKAGOLF,
        slug: "pukagolf",
        name: "PukaGolf",
        status: "active",
        isDemo: false,
        role: "player",
        leagues: [{ id: SATURDAY, slug: "saturday", name: "Saturday League", plays: true }],
      },
    ],
    club_league_choices: () => [
      { id: SATURDAY, name: "Saturday League", status: "active" },
      { id: SUNDAY, name: "Sunday League", status: null },
    ],
    league_request_join: () => "requested",
    league_season: () => season(),
  });

  test("the league page names its league and offers the others", async ({ page }) => {
    const supabase = await openLeague(page, { rpc: twoLeagues() });

    await expect(page.getByText("Saturday League", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Other leagues at PukaGolf" })).toBeVisible();

    await page.getByRole("button", { name: "Ask to play" }).click();
    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/rpc/league_request_join").length).toBe(1);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/league_request_join")[0].body).toEqual({
      in_league_id: SUNDAY,
    });
  });

  test("an address for a league they don't play in says so", async ({ page }) => {
    await openLeague(page, { rpc: twoLeagues() });
    await page.goto("/c/pukagolf/league?league=sunday");

    const notice = page.getByRole("region", { name: "That league" });
    await expect(notice).toContainText("asked for the “sunday” league");
    await expect(notice).toContainText("so this is Saturday League");
    await expect(notice.getByRole("button", { name: "Ask to play" })).toBeVisible();
  });
});

test.describe("standings while a week is played", () => {
  /** Last week final, this week live with Casey through all nine. */
  const withLiveWeek = () => {
    const base = season();
    const live = {
      ...base.rounds[0],
      id: THIS_WEEK,
      name: "Week 2",
      playedOn: "2026-09-14",
      status: "live",
      scores: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((hole) => ({ playerId: CASEY.id, hole, strokes: 3 })),
    };
    return { ...base, rounds: [...base.rounds, live] };
  };

  const openStandings = async (page: Page, count: "final" | "live") => {
    await openLeague(page, {
      tables: { ...leagueTables(), league_rules: [{ league_id: SATURDAY, scoring_mode: "partner", standings_count: count }] },
      rpc: { league_season: withLiveWeek },
    });
    await page.getByRole("tab", { name: "Standings" }).click();
  };

  test("by default only final weeks count, and nobody is called leader early", async ({ page }) => {
    await openStandings(page, "final");

    await expect(page.getByText("1 week counted", { exact: true })).toBeVisible();
    await expect(page.getByText(/Week 2 isn’t in the table yet: the league counts a week once it’s marked final/)).toBeVisible();
    await expect(page.getByText("Current leader · provisional")).toHaveCount(0);
  });

  test("a league that shows the leader during the week marks it provisional", async ({ page }) => {
    await openStandings(page, "live");

    await expect(page.getByText("2 weeks counted · provisional")).toBeVisible();
    await expect(page.getByText("Current leader · provisional")).toBeVisible();
    await expect(page.getByText(/Leading: Casey Tester/)).toBeVisible();
  });
});
