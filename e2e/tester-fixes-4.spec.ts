import { expect, test, type Page } from "@playwright/test";

import { leagueTables, RILEY_ID, THIS_WEEK } from "./fixtures";
import { openLeague } from "./league";

/** The testers' fourth run, fixed. */

const pad = (page: Page) => page.getByRole("region", { name: /^Scoring / });

/**
 * What the pad says, read every 100ms for a while: which hole it is on, and
 * what one hole on the strip holds. Read directly rather than with expect(),
 * which would wait out a wrong moment instead of catching it.
 */
async function watchPad(page: Page, stripHole: number, ms: number) {
  return page.evaluate(
    async ({ stripHole, ms }) => {
      const seen: string[] = [];
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const region = document.querySelector('[aria-label^="Scoring "]');
        const heading = [...(region?.querySelectorAll("p") ?? [])].find((p) => /^Hole \d+$/.test(p.textContent ?? ""));
        const strip = region?.querySelector(`button[aria-label^="Hole ${stripHole}"]`);
        seen.push(`${heading?.textContent} | ${strip?.getAttribute("aria-label")}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      return [...new Set(seen)];
    },
    { stripHole, ms },
  );
}

/**
 * A card that takes its time to reload: every read of the scores waits, so
 * the save has landed well before the page has the card back. The tester saw
 * this as a hole that "didn't take".
 */
async function slowReloads(page: Page, ms: number) {
  await page.route(
    (url) => url.pathname === "/rest/v1/scores",
    async (route) => {
      if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, ms));
      await route.fallback();
    },
  );
}

test.describe("saving a hole", () => {
  test("moves on at once and keeps the score, however slowly the card reloads", async ({ page }) => {
    const supabase = await openLeague(page);
    await slowReloads(page, 2500);

    await expect(pad(page).getByText("Hole 1", { exact: true })).toBeVisible();
    await pad(page).getByRole("button", { name: "One more stroke" }).click();
    await pad(page).getByRole("button", { name: /^Save 5/ }).click();

    // Straight on to hole 2, with hole 1 showing 5, and it stays that way
    // through the moment the save lands and the card is still reloading.
    for (const seen of await watchPad(page, 1, 3500)) {
      expect(seen).toMatch(/^Hole 2 \| Hole 1, 5 strokes/);
    }

    // The next score goes on hole 2, not over hole 1.
    await pad(page).getByRole("button", { name: /^Save 4/ }).click();
    await expect
      .poll(() =>
        supabase.tables.scores
          .filter((s) => s.round_id === THIS_WEEK && s.player_id === RILEY_ID)
          .map((s) => [s.hole, s.strokes])
          .sort(),
      )
      .toEqual([
        [1, 5],
        [2, 4],
      ]);
  });

  test("after a correction, the next score still goes on the hole you came back to", async ({ page }) => {
    const tables = leagueTables();
    tables.scores = [1, 2, 3].map((hole) => ({
      round_id: THIS_WEEK,
      player_id: RILEY_ID,
      hole,
      strokes: 4,
      entered_by: null,
    }));
    const supabase = await openLeague(page, { tables });
    await slowReloads(page, 2500);

    await expect(pad(page).getByText("Hole 4", { exact: true })).toBeVisible();
    await pad(page).getByRole("button", { name: /^Hole 2\b/ }).click();
    await pad(page).getByRole("button", { name: "One more stroke" }).click();
    await pad(page).getByRole("button", { name: "Update 5 · back to hole 4" }).click();

    for (const seen of await watchPad(page, 2, 3500)) {
      expect(seen).toMatch(/^Hole 4 \| Hole 2, 5 strokes/);
    }

    await pad(page).getByRole("button", { name: /^Save 4/ }).click();
    await expect
      .poll(() =>
        supabase.tables.scores
          .filter((s) => s.player_id === RILEY_ID)
          .map((s) => [s.hole, s.strokes])
          .sort(),
      )
      .toEqual([
        [1, 4],
        [2, 5],
        [3, 4],
        [4, 4],
      ]);
  });
});

test.describe("reopening the page", () => {
  test("opens the pad on the first hole without a score", async ({ page }) => {
    const tables = leagueTables();
    tables.scores = [1, 2, 3, 4, 5].map((hole) => ({
      round_id: THIS_WEEK,
      player_id: RILEY_ID,
      hole,
      strokes: 4,
      entered_by: null,
    }));
    await openLeague(page, { tables });
    await page.reload();

    await expect(pad(page).getByText("Hole 6", { exact: true })).toBeVisible();
  });
});

test.describe("a card locked while a hole waited on the phone", () => {
  test("says the card is locked, by whom and when, not that you aren't allowed", async ({
    page,
    context,
  }) => {
    let online = true;
    let locked = false;
    await openLeague(page, {
      override: (call) =>
        !online && call.path.startsWith("/rest/")
          ? { status: 0 }
          : locked && call.method === "POST" && call.path === "/rest/v1/scores"
            ? {
                status: 400,
                body: {
                  code: "23514",
                  message:
                    "The card is locked: signed off by Greg Golfer, Nov 5, 6:12 PM. Only a club admin can change it now.",
                  details: null,
                  hint: "card_locked",
                },
              }
            : undefined,
    });

    online = false;
    await context.setOffline(true);
    await pad(page).getByRole("button", { name: "One more stroke" }).click();
    await pad(page).getByRole("button", { name: /^Save 5/ }).click();

    locked = true;
    online = true;
    await context.setOffline(false);

    await expect(
      page.getByRole("alert").filter({
        hasText:
          "Riley Mock's hole 1 (5) wasn't saved: the card was signed off by Greg Golfer, Nov 5, 6:12 PM.",
      }),
    ).toBeVisible();
    await expect(page.getByText(/you aren't allowed/)).toHaveCount(0);
  });
});

test.describe("when waiting scores go up", () => {
  test("the holes never show blank while the card reloads", async ({ page, context }) => {
    let online = true;
    const supabase = await openLeague(page, {
      override: (call) => (!online && call.path.startsWith("/rest/") ? { status: 0 } : undefined),
    });

    online = false;
    await context.setOffline(true);
    await pad(page).getByRole("button", { name: "One more stroke" }).click();
    await pad(page).getByRole("button", { name: /^Save 5/ }).click();
    await pad(page).getByRole("button", { name: /^Save 4/ }).click();

    await slowReloads(page, 2500);
    online = true;
    await context.setOffline(false);

    // Through "All scores sent" and the slow reload behind it, holes 1 and 2
    // keep their numbers and the pad stays on hole 3.
    for (const seen of await watchPad(page, 1, 3500)) {
      expect(seen).toMatch(/^Hole 3 \| Hole 1, 5 strokes/);
    }
    for (const seen of await watchPad(page, 2, 1000)) {
      expect(seen).toMatch(/^Hole 3 \| Hole 2, 4 strokes/);
    }
    await expect.poll(() => supabase.tables.scores.length).toBe(2);
  });
});
