import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { CASEY, leagueTables, PUKAGOLF, RILEY_ID, SATURDAY, season, THIS_WEEK } from "./fixtures";
import { enterHole, openLeague } from "./league";
import { mockSupabase, type Call, type MockOptions, type MockResponse, type Row } from "./supabase-mock";

/** The testers' seventh run, fixed. */

const SUNDAY = "b0000000-0000-4000-8000-000000000002";
const SUNDAY_WEEK = "00000000-0000-4000-8000-0000000000f1";
const SUNDAY_TEE = "00000000-0000-4000-8000-0000000000f9";

const asAdmin = (tables: Record<string, Row[]>): Record<string, Row[]> => ({
  ...tables,
  profiles: tables.profiles.map((p) => (p.id === CASEY.id ? { ...p, is_admin: true } : p)),
});

/** PukaGolf with a second league, Sunday, which Casey doesn't play in. */
const twoLeagues = (admin: boolean) => () => [
  {
    id: PUKAGOLF,
    slug: "pukagolf",
    name: "PukaGolf",
    status: "active",
    isDemo: false,
    role: admin ? "admin" : "player",
    leagues: [
      { id: SATURDAY, slug: "saturday", name: "Saturday League", plays: true },
      { id: SUNDAY, slug: "sunday", name: "Sunday League", plays: false },
    ],
  },
];

/** Saturday's week, and a final week of Sunday's with Casey and Riley in it. */
const withSundayWeek = () => {
  const tables = asAdmin(leagueTables());
  tables.rounds.push({
    ...tables.rounds[0],
    id: SUNDAY_WEEK,
    league_id: SUNDAY,
    name: "Sunday Week 2",
    played_on: "2026-09-13",
    status: "final",
  });
  tables.tee_times.push({ id: SUNDAY_TEE, round_id: SUNDAY_WEEK, tee_at: "2026-09-13T13:00:00Z", seats: 4 });
  tables.tee_time_players.push(
    { tee_time_id: SUNDAY_TEE, round_id: SUNDAY_WEEK, player_id: CASEY.id, position: 1, played_tee: null },
    { tee_time_id: SUNDAY_TEE, round_id: SUNDAY_WEEK, player_id: RILEY_ID, position: 2, played_tee: null },
  );
  tables.round_settings.push({ ...tables.round_settings[0], round_id: SUNDAY_WEEK });
  return tables;
};

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

const fixAnyCard = (page: Page) => page.getByRole("combobox", { name: "Choose a player to edit" });
const unsent = (page: Page) => page.getByRole("region", { name: "Scores not sent" });

/** How far two boxes overlap, up and down; 0 or less is not at all. */
async function overlap(page: Page, a: ReturnType<Page["locator"]>, b: ReturnType<Page["locator"]>) {
  const [x, y] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  return Math.min(x!.y + x!.height, y!.y + y!.height) - Math.max(x!.y, y!.y);
}

test.describe("Fix a card, in a league that isn't the club's first", () => {
  const overviewRound = (id: string, name: string, playedOn: string, status: string) => ({
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

  test("links to that league's week, with one question mark", async ({ page }) => {
    const supabase = await signIn(page, "/c/pukagolf/admin?league=sunday", {
      tables: withSundayWeek(),
      rpc: {
        my_clubs: twoLeagues(true),
        owner_league_overview: () => ({
          currentRoundId: "00000000-0000-4000-8000-0000000000f2",
          rounds: [
            overviewRound("00000000-0000-4000-8000-0000000000f2", "Sunday Week 3", "2026-09-20", "live"),
            overviewRound(SUNDAY_WEEK, "Sunday Week 2", "2026-09-13", "final"),
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
    expect(supabase.callsTo("POST", "/rest/v1/rpc/owner_league_overview")[0].body).toMatchObject({
      in_league_id: SUNDAY,
    });

    const past = page.getByRole("listitem").filter({ hasText: "Sunday Week 2" });
    const link = past.getByRole("link", { name: "Fix a card" });
    await expect(link).toHaveAttribute("href", `/c/pukagolf/league?week=${SUNDAY_WEEK}&league=sunday`);

    // Clearing it, with Sunday Week 3 Live, says it stays final.
    await past.getByRole("button", { name: "Clear scores" }).click();
    await expect(past).toContainText("It stays final, as Sunday Week 3 is the Live week.");

    // And the league usually plays on Sundays, said by the date it offers.
    await expect(page.getByText("This league plays Sundays")).toBeVisible();
  });

  test("the link opens Sunday's week, not the first league's", async ({ page }) => {
    await signIn(page, `/c/pukagolf/league?week=${SUNDAY_WEEK}&league=sunday`, {
      tables: withSundayWeek(),
      rpc: { my_clubs: twoLeagues(true), card_history: () => [] },
    });
    await expect(page.getByRole("region", { name: "A past week" })).toContainText(
      "You’re looking at Sunday League’s Sunday Week 2 (Sun, Sep 13, final), not this week.",
    );
    await expect(page.getByRole("region", { name: "A past week" })).toContainText("on the Scorecards tab");
  });

  test("a week of another league says so, rather than quietly showing this one", async ({ page }) => {
    // Saturday asked for by name, with a week of Sunday's (round 9: with no
    // league in the address, the week's own league opens instead).
    await signIn(page, `/c/pukagolf/league?week=${SUNDAY_WEEK}&league=saturday`, {
      tables: withSundayWeek(),
      rpc: { my_clubs: twoLeagues(true), card_history: () => [] },
    });
    const notice = page.getByRole("alert").filter({ hasText: "The week asked for" });
    await expect(notice).toContainText(
      "The week asked for is Sunday Week 2 of Sunday League, not one of Saturday League’s, so this is Saturday League’s current week, Week 2.",
    );
    await expect(page.getByRole("region", { name: "A past week" })).toHaveCount(0);

    // And a link to it, in its own league.
    await notice.getByRole("link", { name: "Open Sunday Week 2 in Sunday League" }).click();
    await expect(page.getByRole("region", { name: "A past week" })).toContainText("Sunday League’s Sunday Week 2");
  });

  test("an address with only the week opens the week's own league", async ({ page }) => {
    await signIn(page, `/c/pukagolf/league?week=${SUNDAY_WEEK}`, {
      tables: withSundayWeek(),
      rpc: { my_clubs: twoLeagues(true), card_history: () => [] },
    });
    await expect(page).toHaveURL(/league=sunday/);
    await expect(page.getByRole("region", { name: "A past week" })).toContainText("Sunday League’s Sunday Week 2");
  });
});

test.describe("the card's history", () => {
  test("gives the take-back reason, and calls only a hole that waited offline", async ({ page }) => {
    await openLeague(page, {
      tables: asAdmin(leagueTables()),
      rpc: {
        league_season: () => season(),
        card_history: () => [
          // Entered online: before 0059 it still carried a phone time.
          { at: "2026-09-14T13:41:01.300Z", action: "insert", entity: "score", by: "Casey Mock", hole: 1, strokes: 4, phoneAt: "2026-09-14T13:41:01.000Z" },
          { at: "2026-09-14T13:44:04Z", action: "insert", entity: "score", by: "Casey Mock", hole: 2, strokes: 5, phoneAt: "2026-09-14T13:42:44Z" },
          { at: "2026-09-14T13:50:00Z", action: "take_back", entity: "card", by: "Casey Mock", reason: "Signed by mistake" },
        ],
      },
    });

    await fixAnyCard(page).selectOption({ label: "Riley Mock" });
    await page.getByRole("button", { name: "The card’s history" }).click();
    const history = page.locator("li");

    await expect(history.filter({ hasText: "took back the group's sign-off" })).toContainText(
      "Reason: “Signed by mistake”",
    );
    const online = history.filter({ hasText: "entered 4 on hole 1" });
    await expect(online).toContainText("received");
    await expect(online).not.toContainText("offline");
    await expect(history.filter({ hasText: "entered 5 on hole 2" })).toContainText("offline: entered");
  });
});

test.describe("an entry corrected before it went", () => {
  // Round 9: as its net change, the last number, not every number on the way.
  test("goes up as its last number, with when it was entered", async ({ page, context }) => {
    const phone = signal(context);
    const supabase = await openLeague(page, { override: phone.override });

    await phone.set(false);
    await enterHole(page, 1, 4);
    await enterHole(page, 1, 5);
    await expect(unsent(page)).toContainText("1 hole score not sent yet");

    // Tries with no signal went nowhere; what counts is what goes once it's back.
    const before = supabase.callsTo("POST", "/rest/v1/scores").length;
    await phone.set(true);
    await expect(unsent(page)).toHaveCount(0, { timeout: 15_000 });

    const sent = supabase
      .callsTo("POST", "/rest/v1/scores")
      .slice(before)
      .map((c) => c.body as Row)
      .filter((b) => b.hole === 1);
    expect(sent.map((b) => b.strokes)).toEqual([5]);
    // Each with when it was entered on the phone.
    expect(sent.every((b) => typeof b.entered_on_phone_at === "string")).toBe(true);
  });
});

test.describe("rules saves", () => {
  test("a mode change alone doesn't also save, and log, the rest of the rules", async ({ page }) => {
    const tables = asAdmin(leagueTables());
    tables.league_rules = [
      {
        league_id: SATURDAY,
        points_table: [10, 8, 6],
        completion_point: 1,
        drop_worst: 0,
        min_weeks: 0,
        ranking: "net",
        guests_score: false,
        default_skins_stake: 0,
        default_game: "stroke",
        stableford_points: [5, 4, 3, 2, 1, 0],
        scoring_mode: "partner",
        standings_count: "final",
        double_par_cap: true,
      },
    ];
    const supabase = await signIn(page, "/c/pukagolf/admin", {
      tables,
      rpc: {
        owner_league_overview: () => ({ currentRoundId: THIS_WEEK, rounds: [], players: [], demo: null }),
        club_admin_overview: () => ({ members: [], leagues: [] }),
        owner_restorable_scores: () => [],
        round_completion: () => ({ holeCount: 9, players: [] }),
        league_set_scoring_mode: () => null,
        league_set_standings_count: () => null,
        owner_set_league_rules: () => null,
      },
    });

    await page.getByRole("radio", { name: /^Self Scoring/ }).check();
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Rules saved.")).toBeVisible();

    expect(supabase.callsTo("POST", "/rest/v1/rpc/league_set_scoring_mode")).toHaveLength(1);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/owner_set_league_rules")).toHaveLength(0);

    // A real change to the rest still goes.
    await page.getByLabel("Worst weeks dropped").fill("1");
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/rpc/owner_set_league_rules").length).toBe(1);
  });
});

test.describe("the unsent bar on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("stays off the admin editor's score row after an offline change", async ({ page, context }) => {
    const phone = signal(context);
    await openLeague(page, { tables: asAdmin(leagueTables()), override: phone.override });

    await fixAnyCard(page).selectOption({ label: "Riley Mock" });
    const row = page.locator('section[data-keep-clear] tr[data-keep-clear]').first();
    // The row at the foot of the screen, where the bar comes up.
    await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      window.scrollBy(0, r.bottom - window.innerHeight + 10);
    });
    await phone.set(false);
    const box = row.locator('input[aria-label^="Hole 1,"]');
    await box.fill("4");
    await box.press("Enter");
    await expect(page.getByText("Hole 1: 4, not sent yet.")).toBeVisible();

    await expect(unsent(page)).toBeVisible();
    await expect.poll(() => overlap(page, unsent(page), row)).toBeLessThanOrEqual(0);
  });

  test("stays off the 19th Hole post box, tapped or not", async ({ page, context }) => {
    const phone = signal(context);
    await openLeague(page, { override: phone.override });
    await phone.set(false);
    await enterHole(page, 1, 5);
    await expect(unsent(page)).toBeVisible();

    await page.getByRole("tab", { name: "19th Hole" }).click();
    const post = page.getByLabel("Post to the clubhouse feed").locator("xpath=..");
    await post.evaluate((el) => {
      const r = el.getBoundingClientRect();
      window.scrollBy(0, r.bottom - window.innerHeight + 4);
    });
    await expect.poll(() => overlap(page, unsent(page), post)).toBeLessThanOrEqual(0);

    // Who hasn't teed off isn't on hole 1.
    await expect(page.getByRole("tabpanel", { name: "19th Hole" }).getByText("Not started")).toBeVisible();
  });

  test("Send now with no signal says the try failed, in full", async ({ page, context }) => {
    const phone = signal(context);
    await openLeague(page, { override: phone.override });
    await phone.set(false);
    await enterHole(page, 1, 5);

    await unsent(page).getByRole("button", { name: "Send now" }).click();
    const line = unsent(page).getByRole("status");
    await expect(line).toContainText(/That try failed at .*: no signal\. They go by themselves when it's back\./);
    // Not cut short: every line of it is shown.
    expect(await line.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  });
});
