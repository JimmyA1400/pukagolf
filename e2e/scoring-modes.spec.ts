import { expect, test } from "@playwright/test";

import { CASEY, leagueTables, RILEY_ID, SATURDAY, season, TEE_TIME, THIS_WEEK } from "./fixtures";
import { enterHole, openLeague } from "./league";
import { mockSupabase, type Row } from "./supabase-mock";

const HOLES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** The Saturday League's rules, with only the scoring mode that matters here. */
const tablesFor = (mode: "partner" | "self" | "team"): Record<string, Row[]> => ({
  ...leagueTables(),
  league_rules: [{ league_id: SATURDAY, scoring_mode: mode }],
});

const scoreWrites = (supabase: Awaited<ReturnType<typeof openLeague>>) =>
  supabase.callsTo("POST", "/rest/v1/scores");

test.describe("scoring modes", () => {
  test("Self Scoring: a player keeps their own card", async ({ page }) => {
    const supabase = await openLeague(page, { tables: tablesFor("self") });

    await expect(page.getByText("Your card", { exact: true })).toBeVisible();
    await enterHole(page, 1, 4);

    await expect.poll(() => scoreWrites(supabase).length).toBe(1);
    expect(scoreWrites(supabase)[0].body).toMatchObject({ player_id: CASEY.id, hole: 1, strokes: 4 });
  });

  test("Team Card Scoring: one phone keeps every card in the group", async ({ page }) => {
    const supabase = await openLeague(page, { tables: tablesFor("team") });

    const whose = page.getByRole("group", { name: "Whose card" });
    await whose.getByRole("button", { name: "Riley Mock" }).click();
    await enterHole(page, 1, 5);
    await expect.poll(() => scoreWrites(supabase).length).toBe(1);
    expect(scoreWrites(supabase)[0].body).toMatchObject({ player_id: RILEY_ID, hole: 1, strokes: 5 });

    await whose.getByRole("button", { name: "You" }).click();
    await enterHole(page, 1, 4);
    await expect.poll(() => scoreWrites(supabase).length).toBe(2);
    expect(scoreWrites(supabase)[1].body).toMatchObject({ player_id: CASEY.id, hole: 1, strokes: 4 });
  });
});

test.describe("signing the cards", () => {
  const finished = () => {
    const tables = tablesFor("partner");
    tables.scores = [CASEY.id, RILEY_ID].flatMap((playerId) =>
      HOLES.map((hole) => ({ round_id: THIS_WEEK, player_id: playerId, hole, strokes: 4 })),
    );
    return tables;
  };

  test("the group can't sign until every card has every hole", async ({ page }) => {
    await openLeague(page);

    await expect(page.getByText("Once every card in the group has all 9 holes, the group signs them here.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign the group’s cards" })).toHaveCount(0);
  });

  test("a finished group signs its cards", async ({ page }) => {
    const supabase = await openLeague(page, { tables: finished() });

    await page.getByRole("button", { name: "Sign the group’s cards" }).click();
    // Every card being signed is there to check first.
    const signing = page.getByRole("region", { name: "The cards being signed" });
    await expect(signing).toContainText("Casey Tester");
    await expect(signing).toContainText("Riley Mock");
    await expect(signing).toContainText("36 (E)");
    await signing.getByRole("button", { name: "Sign them" }).click();

    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/rpc/sign_off_group").length).toBe(1);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/sign_off_group")[0].body).toEqual({
      in_tee_time_id: TEE_TIME,
    });
  });

  test("a signed card can't be changed from the scorer's phone", async ({ page }) => {
    const tables = finished();
    tables.card_locks = [CASEY.id, RILEY_ID].map((playerId) => ({
      round_id: THIS_WEEK,
      player_id: playerId,
      locked_at: "2026-09-14T17:00:00Z",
      locked_by: CASEY.id,
    }));

    await mockSupabase(page, { user: CASEY, tables, rpc: { league_season: () => season() } });
    await page.goto("/sign-in");
    await page.getByLabel("Mobile number").fill("2395550132");
    await page.getByLabel("Password").fill("a-good-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.goto("/league");

    await expect(
      page.getByText(/cards are signed off, by Casey Tester for the group\. Only a club admin can change them now\./),
    ).toBeVisible();
    await expect(page.getByText(/^Signed off by Casey Tester(, [^—]+)? — only a club admin can change it$/).first()).toBeVisible();
    await expect(page.getByRole("region", { name: /^Scoring / })).toHaveCount(0);
  });
});
