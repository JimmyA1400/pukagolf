import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { CASEY, leagueTables, RILEY_ID, SATURDAY } from "./fixtures";
import { enterHole, openLeague, scoreOf } from "./league";
import type { Call, MockResponse, Row } from "./supabase-mock";

/** The Saturday League's rules, with only the scoring mode that matters here. */
const tablesFor = (mode: "partner" | "self" | "team"): Record<string, Row[]> => ({
  ...leagueTables(),
  league_rules: [{ league_id: SATURDAY, scoring_mode: mode }],
});

/**
 * The phone's signal. Playwright's offline switch tells the page it's offline,
 * but its routes still answer, so the mock is cut off here too: with no
 * signal, every database call gets no answer at all.
 */
function signal(context: BrowserContext) {
  let on = true;
  return {
    override: (call: Call): MockResponse | undefined =>
      !on && call.path.startsWith("/rest/") ? { status: 0 } : undefined,
    set: async (next: boolean) => {
      on = next;
      await context.setOffline(!next);
    },
  };
}

const unsent = (page: Page) => page.getByRole("region", { name: "Scores not sent" });

const PAPER = /Keep a paper card as well until this clears\. If a phone dies, finish the round on paper and take the card to the pro shop staff\./;

test.describe("scoring with no signal", () => {
  test("Partner Scoring: holes wait on the phone, then go up when the signal is back", async ({
    page,
    context,
  }) => {
    const phone = signal(context);
    const supabase = await openLeague(page, { tables: tablesFor("partner"), override: phone.override });

    await phone.set(false);

    // The group is told straight away, before anything is even entered.
    await expect(unsent(page)).toContainText("No signal");
    // The paper-card advice is one tap away, so the bar stays one line.
    await unsent(page).getByRole("button", { name: "Keep a paper card?" }).click();
    await expect(unsent(page)).toContainText(PAPER);

    await enterHole(page, 1, 5);
    await enterHole(page, 2, 4);

    await expect(unsent(page)).toContainText("2 hole scores not sent yet");
    await expect(unsent(page)).toContainText(PAPER);
    // Shown on the card all the same.
    await expect(scoreOf(page, "Riley Mock")).toHaveText("+1");
    expect(supabase.tables.scores).toHaveLength(0);

    // Still there after the page is closed and opened again.
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith("pukagolf:pending-scores:")).length,
      ),
    ).toBe(1);

    await phone.set(true);

    await expect.poll(() => supabase.tables.scores.length).toBe(2);
    expect(
      supabase.tables.scores.map((s) => [s.player_id, s.hole, s.strokes]).sort(),
    ).toEqual([
      [RILEY_ID, 1, 5],
      [RILEY_ID, 2, 4],
    ]);
    await expect(page.getByRole("status").filter({ hasText: "All scores sent." })).toBeVisible();
    await expect(unsent(page)).toHaveCount(0);
    // And it doesn't stay up for good.
    await expect(page.getByText("All scores sent.")).toHaveCount(0, { timeout: 10_000 });
    await expect(scoreOf(page, "Riley Mock")).toHaveText("+1");
  });

  test("Self Scoring: a player's own card waits on the phone", async ({ page, context }) => {
    const phone = signal(context);
    const supabase = await openLeague(page, { tables: tablesFor("self"), override: phone.override });

    await phone.set(false);
    await enterHole(page, 1, 4);

    await expect(unsent(page)).toContainText("1 hole score not sent yet");
    expect(supabase.tables.scores).toHaveLength(0);

    await phone.set(true);

    await expect.poll(() => supabase.tables.scores.length).toBe(1);
    expect(supabase.tables.scores[0]).toMatchObject({ player_id: CASEY.id, hole: 1, strokes: 4 });
    await expect(unsent(page)).toHaveCount(0);
  });

  test("Team Card Scoring: every card kept on one phone waits, and each goes up once", async ({
    page,
    context,
  }) => {
    const phone = signal(context);
    const supabase = await openLeague(page, { tables: tablesFor("team"), override: phone.override });

    await phone.set(false);

    const whose = page.getByRole("group", { name: "Whose card" });
    await whose.getByRole("button", { name: "Riley Mock" }).click();
    await enterHole(page, 1, 5);
    await whose.getByRole("button", { name: "You" }).click();
    await enterHole(page, 1, 4);

    await expect(unsent(page)).toContainText("2 hole scores not sent yet");
    expect(supabase.tables.scores).toHaveLength(0);

    await phone.set(true);

    await expect.poll(() => supabase.tables.scores.length).toBe(2);
    await expect(unsent(page)).toHaveCount(0);
    // Upserts, so a retry can't make a second row for the same hole.
    expect(
      supabase.tables.scores.map((s) => [s.player_id, s.hole, s.strokes]).sort(),
    ).toEqual(
      [
        [CASEY.id, 1, 4],
        [RILEY_ID, 1, 5],
      ].sort(),
    );
  });

  test("a score refused once the signal is back is said plainly, not lost quietly", async ({
    page,
    context,
  }) => {
    let refuse = false;
    const phone = signal(context);
    await openLeague(page, {
      tables: tablesFor("partner"),
      override: (call) =>
        phone.override(call) ??
        (refuse && call.method === "POST" && call.path === "/rest/v1/scores"
          ? {
              status: 403,
              body: {
                code: "42501",
                message: 'new row violates row-level security policy for table "scores"',
                details: null,
                hint: null,
              },
            }
          : undefined),
    });

    await phone.set(false);
    await enterHole(page, 1, 5);
    await expect(unsent(page)).toContainText("1 hole score not sent yet");

    refuse = true;
    await phone.set(true);

    await expect(
      page.getByRole("alert").filter({
        hasText: "Riley Mock's hole 1 (5) wasn't saved: you aren't allowed to enter a score for this player.",
      }),
    ).toBeVisible();
    await expect(unsent(page)).toHaveCount(0);
    await expect(scoreOf(page, "Riley Mock")).toHaveText("—");
  });
});
