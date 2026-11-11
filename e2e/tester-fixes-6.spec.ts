import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { CASEY, leagueTables, RILEY_ID, SATURDAY, season, THIS_WEEK } from "./fixtures";
import { enterHole, openLeague } from "./league";
import { mockSupabase, type Call, type MockOptions, type MockResponse, type Row } from "./supabase-mock";

/** The testers' sixth run, fixed. */

const LAST_WEEK = "00000000-0000-4000-8000-0000000000d1";
const LAST_TEE = "00000000-0000-4000-8000-0000000000e9";

const asAdmin = (tables: Record<string, Row[]>): Record<string, Row[]> => ({
  ...tables,
  profiles: tables.profiles.map((p) => (p.id === CASEY.id ? { ...p, is_admin: true } : p)),
});

const fixAnyCard = (page: Page) => page.getByRole("combobox", { name: "Choose a player to edit" });
const unsent = (page: Page) => page.getByRole("region", { name: "Scores not sent" });

/** Signed in as Casey, on a page of the club's, without waiting for a scoring pad. */
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

/** The phone's signal, as in offline.spec.ts: off, nothing answers. */
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

test.describe("one card in a past, final week", () => {
  /**
   * Last week, final, with Riley's card signed off and nothing on it: the
   * round-5 stuck card. This week is live.
   */
  const withStuckCard = () => {
    const tables = asAdmin(leagueTables());
    tables.rounds.push({
      ...tables.rounds[0],
      id: LAST_WEEK,
      name: "Week 1",
      played_on: "2026-09-07",
      status: "final",
    });
    tables.tee_times.push({ id: LAST_TEE, round_id: LAST_WEEK, tee_at: "2026-09-07T13:00:00Z", seats: 4 });
    tables.tee_time_players.push(
      { tee_time_id: LAST_TEE, round_id: LAST_WEEK, player_id: CASEY.id, position: 1, played_tee: null },
      { tee_time_id: LAST_TEE, round_id: LAST_WEEK, player_id: RILEY_ID, position: 2, played_tee: null },
    );
    tables.card_locks = [
      { round_id: LAST_WEEK, player_id: RILEY_ID, how: "signed", locked_by: CASEY.id, locked_at: "2026-09-07T17:00:00Z" },
    ];
    return tables;
  };

  test("opens from the admin page, and its sign-off comes back with a reason", async ({ page }) => {
    const tables = withStuckCard();
    const supabase = await signIn(page, `/c/pukagolf/league?week=${LAST_WEEK}`, {
      tables,
      rpc: { admin_take_back_sign_off: () => tables.card_locks.splice(0).length },
    });

    // Last week, not this one, and said so.
    const banner = page.getByRole("region", { name: "A past week" });
    await expect(banner).toContainText("You’re looking at Saturday League’s Week 1 (Mon, Sep 7, final), not this week.");
    await expect(banner).toContainText("season points are worked out again");

    await fixAnyCard(page).selectOption({ label: "Riley Mock" });
    await page.getByRole("button", { name: "Take back the group’s sign-off" }).click();

    const ask = page.getByRole("alert").filter({ hasText: "Take back the group’s sign-off?" });
    await expect(ask).toContainText("The week is final, so the cards stay locked");
    const takeIt = ask.getByRole("button", { name: "Take it back" });
    // A final week needs a reason.
    await expect(takeIt).toBeDisabled();
    await ask.getByLabel("Why (kept in the card’s history)").fill("Signed by mistake, no scores on it");
    await takeIt.click();

    const calls = () => supabase.callsTo("POST", "/rest/v1/rpc/admin_take_back_sign_off");
    await expect.poll(() => calls().length).toBe(1);
    expect(calls()[0].body).toEqual({
      in_round_id: LAST_WEEK,
      in_player_id: RILEY_ID,
      in_reason: "Signed by mistake, no scores on it",
    });
  });

  test("a hole on it changes with a reason, through the locked-card fix", async ({ page }) => {
    const supabase = await signIn(page, `/c/pukagolf/league?week=${LAST_WEEK}`, {
      tables: withStuckCard(),
      rpc: { admin_fix_signed_score: () => null },
    });

    await fixAnyCard(page).selectOption({ label: "Riley Mock" });
    await page.getByLabel("Why is the card changing?").fill("Paper card had a 5 on 1");
    await page.getByRole("button", { name: "Change it anyway" }).click();
    const box = page.locator('section[data-keep-clear] input[aria-label^="Hole 1,"]');
    await box.fill("5");
    await box.press("Enter");

    const calls = () => supabase.callsTo("POST", "/rest/v1/rpc/admin_fix_signed_score");
    await expect.poll(() => calls().length).toBe(1);
    expect(calls()[0].body).toMatchObject({ in_round_id: LAST_WEEK, in_player_id: RILEY_ID, in_hole: 1, in_strokes: 5 });
  });
});

test.describe("the admin page's past weeks", () => {
  const round = (id: string, name: string, playedOn: string, status: string) => ({
    id,
    name,
    playedOn,
    status,
    courseName: "Mock Links",
    holeCount: 9,
    scoreCount: 18,
    playerCount: 2,
    feedCount: 0,
    skinsEnabled: true,
    skinsStake: 0,
  });

  async function openAdmin(page: Page) {
    const tables = asAdmin(leagueTables());
    tables.card_locks = [
      { round_id: LAST_WEEK, player_id: RILEY_ID, how: "signed", locked_by: CASEY.id, locked_at: "2026-09-07T17:00:00Z" },
    ];
    await signIn(page, "/c/pukagolf/admin", {
      tables,
      rpc: {
        owner_league_overview: () => ({
          currentRoundId: THIS_WEEK,
          // A Thursday league whose latest week went on a Friday by mistake.
          rounds: [
            round(THIS_WEEK, "Week 3", "2026-09-18", "live"),
            round(LAST_WEEK, "Week 2", "2026-09-10", "final"),
            round("00000000-0000-4000-8000-0000000000d0", "Week 1", "2026-09-03", "final"),
          ],
          players: [],
          demo: null,
        }),
        club_admin_overview: () => ({ members: [], leagues: [] }),
        owner_restorable_scores: () => [],
        round_completion: () => ({ holeCount: 9, players: [] }),
      },
    });
    await expect(page.getByRole("button", { name: "Start the new week" })).toBeVisible();
  }

  test("each has Fix a card, and clearing a final one says its points change", async ({ page }) => {
    await openAdmin(page);
    const past = page.getByRole("listitem").filter({ hasText: "Week 2" });

    await expect(past.getByRole("link", { name: "Fix a card" })).toHaveAttribute(
      "href",
      `/c/pukagolf/league?week=${LAST_WEEK}`,
    );

    await past.getByRole("button", { name: "Clear scores" }).click();
    await expect(past).toContainText(
      // Week 3 is Live, so it stays final (0059): never two Live weeks.
      "Week 2 is final: clearing it takes its scores out of the standings, so the season’s points change. It stays final, as Week 3 is the Live week.",
    );
    await expect(past).toContainText("The signed-off card opens again too");
  });

  test("the new week is offered on the league's usual day", async ({ page }) => {
    await openAdmin(page);
    // Thursday the 24th, not Friday the 25th.
    await expect(page.getByLabel("Date")).toHaveValue("2026-09-24");
  });
});

test.describe("the pad's double-par stop", () => {
  const pad = (page: Page) => page.getByRole("region", { name: /^Scoring / });
  const more = (page: Page, times: number) =>
    Array.from({ length: times }).reduce<Promise<void>>(
      (done) => done.then(() => pad(page).getByRole("button", { name: "One more stroke" }).click()),
      Promise.resolve(),
    );

  test("says why + stopped", async ({ page }) => {
    await openLeague(page);
    await more(page, 4);
    await expect(pad(page).getByRole("status", { name: "Strokes" })).toHaveText("8");
    await expect(pad(page).getByRole("button", { name: "One more stroke" })).toBeDisabled();
    await expect(pad(page)).toContainText("Max is double par (8) in this league");
  });

  test("goes past it in a league that has turned it off", async ({ page }) => {
    const tables = leagueTables();
    tables.league_rules = [{ league_id: SATURDAY, scoring_mode: "partner", double_par_cap: false }];
    await openLeague(page, { tables });
    await more(page, 5);
    await expect(pad(page).getByRole("status", { name: "Strokes" })).toHaveText("9");
    await expect(pad(page)).not.toContainText("Max is double par");
  });
});

test.describe("an admin's change with no signal", () => {
  test("says it's waiting to send, then saved once it goes", async ({ page, context }) => {
    const phone = signal(context);
    await openLeague(page, { tables: asAdmin(leagueTables()), override: phone.override });

    await fixAnyCard(page).selectOption({ label: "Riley Mock" });
    await phone.set(false);
    const box = page.locator('section[data-keep-clear] input[aria-label^="Hole 1,"]');
    await box.fill("4");
    await box.press("Enter");

    await expect(page.getByText("Hole 1: 4, not sent yet.")).toBeVisible();
    await expect(page.getByText("Saved: hole 1 is 4.")).toHaveCount(0);

    await phone.set(true);
    await expect(page.getByText("Saved: hole 1 is 4.")).toBeVisible();
  });
});

test.describe("the unsent bar on a phone", () => {
  test.use({ viewport: { width: 390, height: 700 } });

  test("moves out of the way of Save, and says when Send now fails", async ({ page }) => {
    // Signal, but nothing answers: PukaGolf itself is down.
    let down = false;
    await openLeague(page, {
      override: (call) => (down && call.path.startsWith("/rest/") ? { status: 0 } : undefined),
    });
    down = true;
    await enterHole(page, 1, 5);
    await expect(unsent(page)).toBeVisible();
    await expect(unsent(page).getByRole("button", { name: "Keep a paper card?" })).toBeVisible();

    // Scrolled so Save sits at the bottom edge, where the bar was.
    const save = page.getByRole("region", { name: /^Scoring / }).getByRole("button", { name: /^(Save|Update) / });
    await save.evaluate((el) => {
      const r = el.getBoundingClientRect();
      window.scrollBy(0, r.bottom - window.innerHeight + 4);
    });
    await expect(unsent(page)).toHaveAttribute("data-edge", "top");
    const [bar, button] = await Promise.all([unsent(page).boundingBox(), save.boundingBox()]);
    const overlap = Math.min(bar!.y + bar!.height, button!.y + button!.height) - Math.max(bar!.y, button!.y);
    expect(overlap).toBeLessThanOrEqual(0);

    // Send now, with nothing answering: it says the try failed.
    await unsent(page).getByRole("button", { name: "Send now" }).click();
    // A try waits up to 20s for an answer before it gives up.
    await expect(unsent(page)).toContainText(/That try failed at .*: no answer from PukaGolf/, { timeout: 30_000 });
  });
});
