import { expect, test, type Page } from "@playwright/test";

import { CASEY, leagueTables, RILEY_ID, season, THIS_WEEK } from "./fixtures";
import { enterHole, openLeague } from "./league";
import { mockSupabase, type Call, type MockOptions, type MockResponse, type Row } from "./supabase-mock";

/** The testers' eighth run, fixed. */

const LAST_WEEK = "00000000-0000-4000-8000-0000000000d1";
const LAST_TEE = "00000000-0000-4000-8000-0000000000e9";

const asAdmin = (tables: Record<string, Row[]>): Record<string, Row[]> => ({
  ...tables,
  profiles: tables.profiles.map((p) => (p.id === CASEY.id ? { ...p, is_admin: true } : p)),
});

const unsent = (page: Page) => page.getByRole("region", { name: "Scores not sent" });

const fixAnyCard = (page: Page) => page.getByRole("combobox", { name: "Choose a player to edit" });

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

/** Last week, final, with Casey and Riley's group signed off. This week is live. */
const signedFinalWeek = () => {
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
  tables.scores.push(
    ...[1, 2, 3].map((hole) => ({
      round_id: LAST_WEEK,
      player_id: RILEY_ID,
      hole,
      strokes: 4,
      entered_by: CASEY.id,
    })),
  );
  tables.card_locks = [
    { round_id: LAST_WEEK, player_id: RILEY_ID, how: "signed", locked_by: CASEY.id, locked_at: "2026-09-07T17:00:00Z" },
    { round_id: LAST_WEEK, player_id: CASEY.id, how: "signed", locked_by: CASEY.id, locked_at: "2026-09-07T17:00:00Z" },
  ];
  return tables;
};

test.describe("a take-back in a final week", () => {
  test("the card stops saying it's signed off, without a reload, and says so", async ({ page }) => {
    const tables = signedFinalWeek();
    await signIn(page, `/c/pukagolf/league?week=${LAST_WEEK}`, {
      tables,
      rpc: { admin_take_back_sign_off: () => tables.card_locks.splice(0).length },
    });

    await fixAnyCard(page).selectOption({ label: "Riley Mock" });
    await expect(page.getByText(/Signed off by/).first()).toBeVisible();
    await page.getByRole("button", { name: "Take back the group’s sign-off" }).click();
    const ask = page.getByRole("alert").filter({ hasText: "Take back the group’s sign-off?" });
    await ask.getByLabel("Why (kept in the card’s history)").fill("Signed the wrong card");
    await ask.getByRole("button", { name: "Take it back" }).click();

    await expect(page.getByText(/Signed off by/)).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "sign-off is taken back" })).toBeVisible();
  });
});

test.describe("putting cleared scores back", () => {
  const round = (id: string, name: string, playedOn: string, status: string, scoreCount: number) => ({
    id,
    name,
    playedOn,
    status,
    courseName: "Mock Links",
    holeCount: 9,
    scoreCount,
    playerCount: 2,
    feedCount: 0,
    skinsEnabled: true,
    skinsStake: 0,
  });

  /** Week 3 Live; Week 2 final, cleared, with 2 holes scored again since. */
  async function openAdmin(page: Page) {
    return signIn(page, "/c/pukagolf/admin", {
      tables: asAdmin(leagueTables()),
      rpc: {
        owner_league_overview: () => ({
          currentRoundId: THIS_WEEK,
          rounds: [
            round(THIS_WEEK, "Week 3", "2026-09-17", "live", 0),
            round(LAST_WEEK, "Week 2", "2026-09-10", "final", 2),
          ],
          players: [],
          demo: null,
        }),
        club_admin_overview: () => ({ members: [], leagues: [] }),
        owner_restorable_scores: () => [
          {
            roundId: LAST_WEEK,
            count: 34,
            kept: 2,
            clearedAt: "2026-09-11T19:00:00Z",
            keptUntil: "2026-09-18T19:00:00Z",
          },
        ],
        owner_restore_scores: () => 34,
        round_completion: () => ({ holeCount: 9, players: [] }),
      },
    });
  }

  test("stays after new scores on a final week, says how long it's kept, and keeps the new ones", async ({ page }) => {
    const supabase = await openAdmin(page);
    const past = page.getByRole("listitem").filter({ hasText: "Week 2" });

    // Two holes have scores again, and it's still there.
    await expect(past).toContainText("kept until Fri, Sep 18");
    await past.getByRole("button", { name: "Put back 34 cleared scores" }).click();
    await expect(past).toContainText(
      "Put the 34 scores back into the holes that are still empty? 2 holes scored since the clear keep their new score. The week stays final.",
    );
    await past.getByRole("button", { name: "Put them back" }).click();

    const calls = () => supabase.callsTo("POST", "/rest/v1/rpc/owner_restore_scores");
    await expect.poll(() => calls().length).toBe(1);
    expect(calls()[0].body).toEqual({ in_round_id: LAST_WEEK });
    await expect(page.getByText("Put back 34 scores in Week 2; 2 holes kept their new score.")).toBeVisible();
  });

  test("Clear all looks like what it is, not like Cancel", async ({ page }) => {
    await openAdmin(page);
    const past = page.getByRole("listitem").filter({ hasText: "Week 2" });
    await past.getByRole("button", { name: "Clear scores" }).click();

    const look = (name: string) =>
      past.getByRole("button", { name, exact: true }).evaluate((el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, color: style.color };
      });
    const clear = await look("Clear all 2");
    const cancel = await look("Cancel");
    expect(clear.background).not.toBe(cancel.background);
    expect(clear.background).not.toBe("rgba(0, 0, 0, 0)");
  });
});

/** PukaGolf answering 503 to everything while it's down; the phone has signal. */
function server() {
  let up = true;
  return {
    override: (call: Call): MockResponse | undefined =>
      !up && call.path.startsWith("/rest/") ? { status: 503, body: { message: "Service Unavailable" } } : undefined,
    set: (next: boolean) => {
      up = next;
    },
  };
}

test.describe("a save held because PukaGolf is down", () => {
  test("Send now fails at once, and the hole says when it was entered", async ({ page }) => {
    const pukagolf = server();
    const supabase = await openLeague(page, { override: pukagolf.override });

    pukagolf.set(false);
    await enterHole(page, 1, 5);
    await expect(unsent(page)).toBeVisible();

    const started = Date.now();
    await unsent(page).getByRole("button", { name: "Send now" }).click();
    await expect(unsent(page).getByRole("status")).toContainText("no answer from PukaGolf", { timeout: 6_000 });
    // The client's own retries, 1s, 2s and 4s apart, held this back 7 seconds.
    expect(Date.now() - started).toBeLessThan(3_000);

    pukagolf.set(true);
    await unsent(page).getByRole("button", { name: "Send now" }).click();
    const sent = () =>
      supabase
        .callsTo("POST", "/rest/v1/scores")
        .map((c) => c.body as Record<string, unknown>)
        .filter((b) => b && b.hole === 1);
    await expect.poll(() => sent().some((b) => typeof b.entered_on_phone_at === "string")).toBe(true);
  });
});

test.describe("the stroke dots on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("sit above a bogey's box, not on its lines", async ({ page }) => {
    const tables = leagueTables();
    // Casey's own card, kept by Riley: read only here, a bogey on hole 1,
    // where Casey gets a stroke.
    tables.scores.push({ round_id: THIS_WEEK, player_id: CASEY.id, hole: 1, strokes: 5, entered_by: RILEY_ID });
    await openLeague(page, { tables });

    const dots = page.locator("[data-stroke-dots]").filter({ hasText: "•" }).first();
    await dots.scrollIntoViewIfNeeded();
    const cell = dots.locator("xpath=..");
    const box = cell.locator("span.inline-flex").first();
    const [d, b] = await Promise.all([dots.boundingBox(), box.boundingBox()]);
    expect(d!.y + d!.height).toBeLessThanOrEqual(b!.y + 0.5);
  });
});
