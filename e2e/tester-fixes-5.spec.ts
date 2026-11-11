import { expect, test, type Page } from "@playwright/test";

import { CASEY, leagueTables, RILEY_ID, season, THIS_WEEK } from "./fixtures";
import { openLeague } from "./league";
import { mockSupabase, type MockOptions, type Row } from "./supabase-mock";

/** The testers' fifth run, fixed. */

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
    entered_by: playerId === CASEY.id ? RILEY_ID : CASEY.id,
  }));

const fixAnyCard = (page: Page) => page.getByRole("combobox", { name: "Choose a player to edit" });

/**
 * Signed in as Casey, on a page of the club's: as openLeague does, without
 * waiting for a scoring pad, which a signed-off group doesn't have.
 */
async function signIn(page: Page, path: string, options: Partial<MockOptions>) {
  const supabase = await mockSupabase(page, {
    user: CASEY,
    ...options,
    rpc: { league_season: () => season(), ...options.rpc },
  });

  await page.goto("/sign-in");
  await page.getByLabel("Mobile number").fill("2395550132");
  await page.getByLabel("Password").fill("a-good-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.goto(path);

  return supabase;
}

test.describe("Sunlight mode on a phone", () => {
  test("the editable full card shows every hole's whole number", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("pukagolf:sunlight", "1"));

    const tables = leagueTables();
    // Riley's card, the one Casey keeps: two figures on one hole, the widest a box holds.
    tables.scores = card(RILEY_ID, [5, 5, 2, 7, 4, 5, 3, 10]);
    await openLeague(page, { tables });
    await page.getByRole("button", { name: "Full card", exact: true }).click();

    const boxes = page.locator('input[aria-label^="Hole "]');
    await expect(boxes).toHaveCount(9);

    // Each box measured against the number in it, in the box's own font: the
    // tester saw 13px of room for a 16px digit, so every score was cut in half.
    const room = await boxes.evaluateAll((inputs) =>
      (inputs as HTMLInputElement[]).map((input) => {
        const style = getComputedStyle(input);
        const inside =
          input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const pen = document.createElement("canvas").getContext("2d")!;
        pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const needed = pen.measureText(input.value || "10").width;
        return { hole: input.getAttribute("aria-label"), inside, needed, scrolls: input.scrollWidth > input.clientWidth };
      }),
    );

    for (const box of room) {
      expect(box.scrolls, `${box.hole} scrolls its number`).toBe(false);
      expect(box.inside, `${box.hole}: room for its number`).toBeGreaterThanOrEqual(box.needed);
    }

    // And the card still fits the phone: the total isn't pushed off the edge.
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(fits).toBe(true);
  });
});

test.describe("taking back a group's sign-off", () => {
  const signedGroup = () => {
    const tables = asAdmin(leagueTables());
    tables.scores = [...card(CASEY.id, [4, 4, 4, 4, 4, 4, 4, 4, 4]), ...card(RILEY_ID, [5, 5, 5, 5, 5, 5, 5, 5, 5])];
    tables.card_locks = [CASEY.id, RILEY_ID].map((player_id) => ({
      round_id: THIS_WEEK,
      player_id,
      how: "signed",
      locked_by: CASEY.id,
      locked_at: "2026-09-14T17:00:00Z",
    }));
    return tables;
  };

  test("asks first, then frees every card in the group, the admin's own included", async ({ page }) => {
    const tables = signedGroup();
    const supabase = await signIn(page, "/league", {
      tables,
      rpc: {
        // As the database does it: every card the group signed opens.
        admin_take_back_sign_off: () => tables.card_locks.splice(0).length,
      },
    });

    // The admin's own card is in the list now, so it can't get stuck signed.
    await fixAnyCard(page).selectOption({ label: "You (your own card)" });
    await expect(page.getByText(/you\s+can.t enter or change them from here/)).toBeVisible();

    await page.getByRole("button", { name: "Take back the group’s sign-off" }).click();
    const ask = page.getByRole("alert").filter({ hasText: "Take back the group’s sign-off?" });
    await expect(ask).toContainText("Every card the group signed opens again: Riley Mock, yours.");

    const calls = () => supabase.callsTo("POST", "/rest/v1/rpc/admin_take_back_sign_off");
    expect(calls()).toHaveLength(0);

    await ask.getByRole("button", { name: "Take it back" }).click();
    await expect.poll(() => calls().length).toBe(1);
    expect(calls()[0].body).toEqual({ in_round_id: THIS_WEEK, in_player_id: CASEY.id });
    // Not the one-card unlock any more.
    expect(supabase.callsTo("POST", "/rest/v1/rpc/admin_set_card_lock")).toHaveLength(0);

    // Both cards are open again: the group can sign once more.
    await expect(page.getByRole("button", { name: "Sign the group’s cards" })).toBeVisible();
  });

  test("Keep it signed changes nothing", async ({ page }) => {
    const supabase = await signIn(page, "/league", { tables: signedGroup() });

    await fixAnyCard(page).selectOption({ label: "Riley Mock" });
    await page.getByRole("button", { name: "Take back the group’s sign-off" }).click();
    await page.getByRole("button", { name: "Keep it signed" }).click();

    await expect(page.getByRole("alert").filter({ hasText: "Take back the group’s sign-off?" })).toHaveCount(0);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/admin_take_back_sign_off")).toHaveLength(0);
  });
});

test.describe("starting a new week over unfinished cards", () => {
  const overview = (status = "live") => ({
    currentRoundId: THIS_WEEK,
    rounds: [
      {
        id: THIS_WEEK,
        name: "Week 2",
        playedOn: "2026-09-14",
        status,
        courseName: "Mock Links",
        holeCount: 9,
        scoreCount: 13,
        playerCount: 2,
        feedCount: 0,
        skinsEnabled: true,
        skinsStake: 0,
      },
    ],
    players: [],
    demo: null,
  });

  async function openAdmin(page: Page, posted: { casey: number; riley: number }, signed = 0) {
    const tables = asAdmin(leagueTables());
    tables.card_locks = Array.from({ length: signed }, (_, i) => ({
      round_id: THIS_WEEK,
      player_id: [CASEY.id, RILEY_ID][i],
      how: "signed",
      locked_by: CASEY.id,
      locked_at: "2026-09-14T17:00:00Z",
    }));
    const supabase = await signIn(page, "/c/pukagolf/admin", {
      tables,
      rpc: {
        owner_league_overview: () => overview(),
        club_admin_overview: () => ({ members: [], leagues: [] }),
        owner_restorable_scores: () => [],
        round_completion: () => ({
          holeCount: 9,
          players: [
            { playerId: CASEY.id, name: "Casey Tester", posted: posted.casey },
            { playerId: RILEY_ID, name: "Riley Mock", posted: posted.riley },
          ],
        }),
        owner_start_new_week: () => "00000000-0000-4000-8000-0000000000d3",
        owner_clear_round_scores: () => 13,
      },
    });
    await expect(page.getByRole("button", { name: "Start the new week" })).toBeVisible();
    return supabase;
  }

  const starts = (supabase: Awaited<ReturnType<typeof openAdmin>>) =>
    supabase.callsTo("POST", "/rest/v1/rpc/owner_start_new_week");

  test("names who isn't finished, and asks before marking the week final", async ({ page }) => {
    const supabase = await openAdmin(page, { casey: 9, riley: 4 });

    // The note above the button already says so, unlike a finished week's.
    await expect(
      page.getByText(
        "One card isn't finished: Riley Mock (5 holes left) in Week 2. Starting the new week marks Week 2 final anyway",
        { exact: false },
      ),
    ).toBeVisible();

    await page.getByRole("button", { name: "Start the new week" }).click();
    const ask = page.getByRole("alert").filter({ hasText: "Mark Week 2 final anyway?" });
    await expect(ask).toContainText("Riley Mock (5 holes left)");
    expect(starts(supabase)).toHaveLength(0);

    await ask.getByRole("button", { name: "Not yet" }).click();
    expect(starts(supabase)).toHaveLength(0);

    await page.getByRole("button", { name: "Start the new week" }).click();
    await page.getByRole("button", { name: "Mark it final and start" }).click();
    await expect.poll(() => starts(supabase).length).toBe(1);
  });

  test("with every card finished, it starts at once, as before", async ({ page }) => {
    const supabase = await openAdmin(page, { casey: 9, riley: 9 });

    await expect(page.getByText("Every card in Week 2 is finished, so it is marked final")).toBeVisible();
    await page.getByRole("button", { name: "Start the new week" }).click();
    await expect.poll(() => starts(supabase).length).toBe(1);
    await expect(page.getByText("Mark Week 2 final anyway?")).toHaveCount(0);
  });

  test("clearing a week's scores says its sign-offs are taken back", async ({ page }) => {
    await openAdmin(page, { casey: 9, riley: 9 }, 2);

    await page.getByRole("button", { name: "Clear scores", exact: true }).first().click();
    await expect(
      page.getByText("The 2 signed-off or locked cards open again too: the groups score and sign again."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear all 13" }).click();
    await expect(page.getByText(/Cleared 13 scores from Week 2\. The 2 signed-off or locked cards are open again/)).toBeVisible();
  });
});

