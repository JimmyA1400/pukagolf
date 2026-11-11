import { expect, test } from "@playwright/test";

import { CASEY, JORDAN_ID, leagueTables, RILEY_ID, SATURDAY, season, TAYLOR_ID } from "./fixtures";
import { enterHole, leaderboard, openLeague, scoreOf } from "./league";

/** Eight cards over a par-35 nine, the last two on the same gross total. */
const TIE_FIELD = [
  { id: CASEY.id, name: "Jordan Fairway", index: 1, card: [4, 6, 5, 6, 4, 3, 4, 4, 3] },
  { id: RILEY_ID, name: "Drew Divot", index: 8.5, card: [4, 6, 6, 5, 5, 3, 4, 4, 5] },
  { id: "00000000-0000-4000-8000-000000000101", name: "Jamie Caddie", index: 16.5, card: [4, 6, 6, 7, 5, 3, 4, 5, 3] },
  { id: "00000000-0000-4000-8000-000000000102", name: "Alex Player", index: 14.9, card: [5, 6, 5, 7, 6, 3, 4, 5, 3] },
  { id: "00000000-0000-4000-8000-000000000103", name: "Casey Birdie", index: 12, card: [6, 7, 5, 7, 5, 3, 5, 5, 3] },
  { id: "00000000-0000-4000-8000-000000000104", name: "Sam Golfer", index: 14.6, card: [5, 5, 5, 7, 6, 3, 6, 5, 5] },
  { id: "00000000-0000-4000-8000-000000000105", name: "Bailey Chipper", index: 7.8, card: [4, 8, 6, 6, 6, 3, 5, 6, 4] },
  { id: "00000000-0000-4000-8000-000000000106", name: "Morgan Bunker", index: 30, card: [5, 6, 5, 9, 5, 4, 5, 4, 5] },
];

const TIE_PARS = { 1: 4, 2: 4, 3: 4, 4: 5, 5: 4, 6: 3, 7: 4, 8: 4, 9: 3 };

const eightWithATie = () => ({
  year: 2026,
  leagueSkins: true,
  rules: {
    points: [10, 8, 6, 5, 4, 3, 2],
    completionPoint: 1,
    dropWorst: 0,
    minWeeks: 0,
    ranking: "net",
    guestsScore: false,
  },
  players: TIE_FIELD.map((p) => ({
    id: p.id,
    name: p.name,
    handicapIndex: p.index,
    preferredTee: null,
  })),
  rounds: [
    {
      id: "00000000-0000-4000-8000-0000000000d9",
      name: "Saturday Round 1",
      playedOn: "2026-09-07",
      status: "final",
      holeCount: 9,
      startHole: 1,
      game: "stroke",
      skinsEnabled: true,
      skinsStake: 0,
      pars: TIE_PARS,
      strokeIndexes: { 1: 15, 2: 3, 3: 5, 4: 1, 5: 11, 6: 17, 7: 13, 8: 9, 9: 7 },
      tees: [{ tee: "white", courseRating: null, slope: null, yardage: 6080 }],
      groups: [
        { id: "gg1", playerIds: TIE_FIELD.slice(0, 4).map((p) => p.id), playedTees: {} },
        { id: "gg2", playerIds: TIE_FIELD.slice(4).map((p) => p.id), playedTees: {} },
      ],
      scores: TIE_FIELD.flatMap((p) =>
        p.card.map((strokes, i) => ({ playerId: p.id, hole: i + 1, strokes })),
      ),
    },
  ],
});

test.describe("scoring a league round", () => {
  test("a scorer enters a hole and the leaderboard follows, gross then net", async ({ page }) => {
    const supabase = await openLeague(page);

    expect(supabase.callsTo("POST", "/auth/v1/token")[0]?.body).toMatchObject({
      phone: "+12395550132",
      password: "a-good-password",
    });

    await enterHole(page, 1, 5);

    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/scores").length).toBe(1);
    const write = supabase.callsTo("POST", "/rest/v1/scores")[0];
    expect(write.params.get("on_conflict")).toBe("round_id,player_id,hole");
    expect(write.body).toMatchObject({
      player_id: RILEY_ID,
      hole: 1,
      strokes: 5,
      entered_by: CASEY.id,
    });

    // A bogey on a par 4.
    await expect(scoreOf(page, "Riley Mock")).toHaveText("+1");

    // Riley's 2 strokes fall on the two hardest holes, and hole 1 is the
    // hardest, so the bogey is a net par.
    await page.getByRole("button", { name: "Net", exact: true }).click();
    await expect(leaderboard(page)).toContainText("Strokes: Casey T. 5 · Riley M. 2");
    await expect(scoreOf(page, "Riley Mock")).toHaveText("E");
  });

  test("a refused score is explained, not dropped", async ({ page }) => {
    await openLeague(page, {
      override: (call) =>
        call.method === "POST" && call.path === "/rest/v1/scores"
          ? {
              status: 403,
              body: {
                code: "42501",
                message: 'new row violates row-level security policy for table "scores"',
                details: null,
                hint: null,
              },
            }
          : undefined,
    });

    await enterHole(page, 1, 5);

    await expect(
      page.getByRole("alert").filter({ hasText: "You aren't allowed to enter a score for this player." }),
    ).toBeVisible();
    await expect(scoreOf(page, "Riley Mock")).toHaveText("—");
  });

  test("with no signal a score waits on the phone and sends when signal returns", async ({
    page,
  }) => {
    let signal = false;
    const supabase = await openLeague(page, {
      // Until the signal comes back, a score write gets no answer at all.
      override: (call) =>
        !signal && call.method === "POST" && call.path === "/rest/v1/scores"
          ? { status: 0 }
          : undefined,
    });

    await enterHole(page, 1, 5);

    await expect(page.getByText("1 hole score not sent yet")).toBeVisible();
    // Shown straight away, not held back until it's sent.
    await expect(scoreOf(page, "Riley Mock")).toHaveText("+1");
    expect(supabase.tables.scores).toHaveLength(0);

    signal = true;
    await page.getByRole("button", { name: "Send now", exact: true }).click();

    await expect.poll(() => supabase.tables.scores.length).toBe(1);
    await expect(page.getByText(/not sent yet/)).toHaveCount(0);
    await expect(scoreOf(page, "Riley Mock")).toHaveText("+1");
  });

  test("a back-nine week is scored as holes 10 to 18", async ({ page }) => {
    const supabase = await openLeague(page, { tables: leagueTables({ backNine: true }) });
    const pad = page.getByRole("region", { name: /^Scoring / });

    await expect(pad).toContainText("Hole 10");

    await enterHole(page, 10, 5);

    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/scores").length).toBe(1);
    expect(supabase.callsTo("POST", "/rest/v1/scores")[0].body).toMatchObject({
      hole: 10,
      strokes: 5,
    });
    await expect(pad).toContainText("Hole 11");
    await expect(scoreOf(page, "Riley Mock")).toHaveText("+1");

    // The leaderboard's columns are the holes being played.
    const board = leaderboard(page);
    await expect(board.getByRole("columnheader", { name: "10", exact: true })).toBeVisible();
    await expect(board.getByRole("columnheader", { name: "1", exact: true })).toHaveCount(0);

    // Riley's 2 strokes land on the back nine's two hardest holes, 10 and 11,
    // so the bogey on 10 is a net par.
    await page.getByRole("button", { name: "Net", exact: true }).click();
    await expect(scoreOf(page, "Riley Mock")).toHaveText("E");
  });

  test("a Stableford week is scored in points, not strokes", async ({ page }) => {
    await openLeague(page, { tables: leagueTables({ game: "stableford" }) });

    const board = leaderboard(page);
    await expect(board.getByRole("columnheader", { name: "Points", exact: true })).toBeVisible();

    // A bogey on a par 4 is worth a point, and the round is still level par
    // as far as strokes go — points are what the week is ranked on.
    await enterHole(page, 1, 5);
    await expect(scoreOf(page, "Riley Mock")).toHaveText("1");

    await enterHole(page, 2, 3);
    await expect(scoreOf(page, "Riley Mock")).toHaveText("4");
  });

  test("a scramble is one card for the group, sent once", async ({ page }) => {
    const tables = leagueTables({ game: "scramble" });
    const supabase = await openLeague(page, {
      tables,
      rpc: {
        league_season: () => season(),
        // What enter_team_score does: the same number onto every card.
        enter_team_score: (args) => {
          for (const playerId of [CASEY.id, RILEY_ID]) {
            tables.scores.push({
              round_id: args.in_round_id,
              player_id: playerId,
              hole: args.in_hole,
              strokes: args.in_strokes,
              entered_by: CASEY.id,
            });
          }

          return 2;
        },
      },
    });

    await expect(page.getByText(/One ball between you/)).toBeVisible();

    await enterHole(page, 1, 5);

    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/rpc/enter_team_score").length).toBe(1);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/enter_team_score")[0].body).toMatchObject({
      in_hole: 1,
      in_strokes: 5,
    });
    // One call, not one per player, and no plain score writes at all.
    expect(supabase.callsTo("POST", "/rest/v1/scores")).toHaveLength(0);

    // The side is one row on the board, named for who is on it.
    const board = leaderboard(page);
    const side = board.getByRole("row", { name: /Casey T\./ });
    await expect(side).toHaveCount(1);
    await expect(side.getByRole("cell").nth(2)).toHaveText("+1");
    await expect(side).toContainText("Riley M.");

    // Every card in a group carries the same number, so there is no skins game.
    await expect(page.getByRole("tab", { name: "Skins", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Net", exact: true })).toHaveCount(0);
  });

  test("groups can be compared against each other as best ball", async ({ page }) => {
    const tables = leagueTables({ twoGroups: true });
    // Hole 1 played by both groups before anyone opens the page.
    tables.scores.push(
      { round_id: tables.rounds[0].id, player_id: CASEY.id, hole: 1, strokes: 5, entered_by: CASEY.id },
      { round_id: tables.rounds[0].id, player_id: RILEY_ID, hole: 1, strokes: 4, entered_by: CASEY.id },
      { round_id: tables.rounds[0].id, player_id: TAYLOR_ID, hole: 1, strokes: 6, entered_by: TAYLOR_ID },
      { round_id: tables.rounds[0].id, player_id: JORDAN_ID, hole: 1, strokes: 6, entered_by: TAYLOR_ID },
    );
    // A league that shows the current leader while the week is played.
    tables.league_rules = [{ league_id: SATURDAY, scoring_mode: "partner", standings_count: "live" }];
    await openLeague(page, { tables });

    const leader = page.locator("section").filter({ hasText: /Current leader|Leading group/ }).first();

    // Riley's 4 is the best individual card.
    await expect(leader).toContainText("Riley Mock");

    await page.getByRole("button", { name: "Groups", exact: true }).click();

    // Group 1's best ball is Riley's 4 — level par; group 2's is a 6.
    await expect(page.getByText("Leading group", { exact: false })).toBeVisible();
    await expect(leader.getByRole("listitem").first()).toContainText("Casey T., Riley M.");
    await expect(leader.getByRole("listitem").first()).toContainText("E");
    await expect(leader.getByRole("listitem").nth(1)).toContainText("Taylor S., Jordan S.");
    await expect(leader.getByRole("listitem").nth(1)).toContainText("+2");

    // The week itself is untouched by the side game.
    await expect(leaderboard(page).getByRole("columnheader", { name: "Player", exact: true })).toBeVisible();
    await expect(scoreOf(page, "Riley Mock")).toHaveText("E");

    await page.getByRole("button", { name: "Players", exact: true }).click();
    await expect(leader).toContainText("Riley Mock");
  });

  test("the Standings tab ranks last week net", async ({ page }) => {
    await openLeague(page);

    await page.getByRole("tab", { name: "Standings", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Standings" });
    const points = (name: string) =>
      panel.getByRole("row", { name: new RegExp(name) }).getByRole("cell").nth(2);

    await expect(points("Casey Tester")).toHaveText("10");
    await expect(points("Riley Mock")).toHaveText("8");
    await expect(panel).toContainText("Week 1");
  });

  test("the Standings tab can be read net or gross, table and weeks together", async ({
    page,
  }) => {
    await openLeague(page);
    await page.getByRole("tab", { name: "Standings", exact: true }).click();

    const panel = page.getByRole("tabpanel", { name: "Standings" });
    // Pos, Player, Pts, Wks, Wins, Avg.
    const average = (name: string) =>
      panel.getByRole("row", { name: new RegExp(name) }).getByRole("cell").nth(5);
    const weeks = panel.locator("section").filter({ hasText: "Week by week" });

    // The league ranks net, so that is what it opens on: Casey's 36 gross
    // against 5 strokes is 31, five under the nine's par of 36.
    await expect(average("Casey Tester")).toHaveText("-5");
    await expect(average("Riley Mock")).toHaveText("+7");
    await expect(weeks).toContainText("net");

    // One control for the tab; the weeks below follow the table.
    await panel.getByRole("button", { name: "Gross", exact: true }).click();

    await expect(average("Casey Tester")).toHaveText("E");
    await expect(average("Riley Mock")).toHaveText("+9");
    await expect(weeks).toContainText("gross");
    await expect(panel).toContainText("The league’s own table is net");
  });

  test("switching to gross re-ranks the field without losing or repeating anyone", async ({
    page,
  }) => {
    // A real week's shape: eight cards, and the last two round in the same
    // gross total, so gross has a tie where net has none.
    await openLeague(page, { rpc: { league_season: eightWithATie } });
    await page.getByRole("tab", { name: "Standings", exact: true }).click();

    const panel = page.getByRole("tabpanel", { name: "Standings" });
    const table = () =>
      panel.locator("table tbody tr").evaluateAll((rows) =>
        rows.map((r) =>
          Array.from(r.querySelectorAll("td")).map((c) => c.textContent?.trim() ?? ""),
        ),
      );

    await expect.poll(async () => (await table()).length).toBe(8);
    await panel.getByRole("button", { name: "Gross", exact: true }).click();

    await expect.poll(async () => (await table())[7]?.[1]).toBe("Morgan Bunker");

    const rows = await table();
    const names = rows.map((r) => r[1]);
    // Every player once, and nobody left over from the net table.
    expect(new Set(names).size).toBe(8);
    expect(names).toContain("Bailey Chipper");

    // Both went round in 48. They share seventh, and share its points.
    expect(rows[6].slice(0, 3)).toEqual(["7", "Bailey Chipper", "2"]);
    expect(rows[7].slice(0, 3)).toEqual(["7", "Morgan Bunker", "2"]);
  });

  test("with skins on, there's a pot and a Skins tab", async ({ page }) => {
    await openLeague(page);

    await page.getByRole("tab", { name: "19th Hole", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "19th Hole" })).toContainText(/skins/i);

    await page.getByRole("tab", { name: "Skins", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Skins" })).toContainText(
      "No stake set for this week",
    );
  });

  test("with skins off for the league, the pot and the Skins tab are gone", async ({ page }) => {
    await openLeague(page, { rpc: { league_season: () => season({ leagueSkins: false }) } });

    await expect(page.getByRole("tab", { name: "Standings", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Skins", exact: true })).toHaveCount(0);

    await page.getByRole("tab", { name: "19th Hole", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "19th Hole" })).not.toContainText(/skins/i);
  });
});
