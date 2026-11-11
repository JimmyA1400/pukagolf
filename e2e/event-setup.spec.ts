import { expect, test, type Page } from "@playwright/test";

import { CASEY, leagueTables } from "./fixtures";
import { mockSupabase, type Row } from "./supabase-mock";

const EVENT = "00000000-0000-4000-8000-0000000000f1";
const HOLES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Nine players with indexes far enough apart to make the draft visible. */
const FIELD = [
  ["Ann Abbot", 1.2],
  ["Ben Barlow", 4.6],
  ["Cal Curtis", 7.1],
  ["Dee Dalton", 9.4],
  ["Eli Easton", 11.8],
  ["Fay Finch", 14.3],
  ["Gus Grier", 17.5],
  ["Hal Hobbs", 21.9],
  ["Ivy Irwin", 26.4],
] as const;

const playerId = (i: number) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`;

/**
 * What league_event() hands back.
 *
 * `inCount` is how many said they're in — the rest are invited and haven't
 * answered, which is what makes the headcount in step 1 worth showing.
 * `drafted` pairs the first players up into sides of `teamSize`.
 */
function leagueEvent({
  formatId = "best_ball",
  teamSize = 2,
  inCount = 8,
  drafted = true,
}: {
  formatId?: string;
  teamSize?: number;
  inCount?: number;
  drafted?: boolean;
} = {}): Row {
  const roster = FIELD.map(([name, handicapIndex], i) => ({
    id: playerId(i),
    profileId: null,
    name,
    position: i + 1,
    status: i < inCount ? "in" : "undecided",
    isGuest: false,
    handicapIndex,
    preferredTee: null,
    playedTee: "white",
  }));

  // The same snake the app drafts with: sorted by index, 1-2-3-4 then back.
  const playing = roster.slice(0, inCount);
  const sides = Math.floor(playing.length / teamSize);
  const teams = drafted
    ? Array.from({ length: sides }, (_, t) => ({
        id: `team-${t + 1}`,
        name: `Team ${t + 1}`,
        position: t + 1,
        memberIds: Array.from({ length: teamSize }, (_, round) =>
          playing[round % 2 === 0 ? round * sides + t : round * sides + (sides - 1 - t)].id,
        ),
      }))
    : [];

  return {
    event: {
      id: EVENT,
      name: "Club Scramble",
      playedOn: "2026-09-26",
      formatId,
      teamSize,
      holeCount: 9,
      startHole: 1,
      isSimulator: false,
      countsForStandings: false,
      courseId: null,
      courseName: "Mock Links",
      skinsEnabled: false,
      skinsStake: 0,
    },
    roster,
    teams,
    teeTimes: [],
    scores: [],
    pars: Object.fromEntries(HOLES.map((hole) => [String(hole), 4])),
    strokeIndexes: {},
    tees: [{ tee: "white", courseRating: null, slope: null, yardage: 3150 }],
  };
}

/** Sign in as the league admin and open one event's setup page. */
async function openEvent(page: Page, event: Row = leagueEvent()) {
  const tables = leagueTables();
  tables.profiles = tables.profiles.map((p) =>
    p.id === CASEY.id ? { ...p, is_admin: true } : p,
  );

  const supabase = await mockSupabase(page, {
    user: CASEY,
    tables,
    rpc: { league_event: () => event },
  });

  await page.goto("/sign-in");
  await page.getByLabel("Mobile number").fill("2395550132");
  await page.getByLabel("Password").fill("a-good-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");

  await page.goto(`/league/events/${EVENT}`);
  await expect(page.getByRole("heading", { name: "Club Scramble" })).toBeVisible();

  return supabase;
}

const step = (page: Page, name: string | RegExp) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name, level: 2 }) });

test.describe("setting up a league event", () => {
  test("counts the field, and says where the number comes from", async ({ page }) => {
    await openEvent(page);

    const who = step(page, "How many are playing");

    // Eight of nine said yes, and the ninth is named as not having answered.
    // Matched as exact text: no handicap in this field is a bare "8", and the
    // headcount is deliberately not a live region to announce itself by.
    await expect(who.getByText("8", { exact: true })).toBeVisible();
    await expect(who).toContainText("No ceiling. Starts at the number who said they’re in");
    await expect(who).toContainText("1 of 9 invited haven’t");
  });

  test("offers only the formats the chosen team size can play", async ({ page }) => {
    await openEvent(page);

    const format = step(page, "Format");

    // Two-man formats, and nothing that needs three or four.
    await expect(format.getByRole("button", { name: /Best Ball/ })).toBeVisible();
    await expect(format.getByRole("button", { name: /Alternate Shot/ })).toBeVisible();
    await expect(format.getByRole("button", { name: /Greensomes/ })).toBeVisible();
    await expect(format.getByRole("button", { name: /Nines/ })).toHaveCount(0);
    await expect(format.getByRole("button", { name: /2 Best Balls/ })).toHaveCount(0);

    // The chosen one is the pressed one, and it is tagged by how it is played.
    const chosen = format.getByRole("button", { name: /Best Ball/ });
    await expect(chosen).toHaveAttribute("aria-pressed", "true");
    await expect(chosen).toContainText("own ball");
    await expect(chosen).toContainText("strokes");
  });

  test("a field that divides is confirmed rather than warned about", async ({ page }) => {
    await openEvent(page);

    await expect(step(page, "Format")).toContainText(
      "8 playing → 4 sides of 2, none left over. Ready for tee times.",
    );
  });

  test("a leftover player is headlined, offered fixes, and still seated nowhere", async ({
    page,
  }) => {
    await openEvent(page, leagueEvent({ inCount: 9 }));

    const format = step(page, "Format");

    await expect(format).toContainText("1 player left over");
    await expect(format).toContainText("9 players → 4 teams of 2, 1 left over");
    // Every fix is offered as something to press, not as a label.
    await expect(format.getByRole("button", { name: "Invite 1 more" })).toBeVisible();
    await expect(format.getByRole("button", { name: "Give them a bye" })).toBeVisible();
    await expect(format.getByRole("button", { name: "Blind draw" })).toBeVisible();

    // And the warning never blocks: the sides are drafted anyway, with the
    // odd one out shown as waiting rather than dropped off the page.
    const review = step(page, "Review the teams");
    await expect(review).toContainText("Left over");
    await expect(review).toContainText("1 waiting");
  });

  test("a bye sets the warning aside without pretending to enforce one", async ({ page }) => {
    await openEvent(page, leagueEvent({ inCount: 9 }));

    await step(page, "Format").getByRole("button", { name: "Give them a bye" }).click();

    await expect(page.getByRole("status")).toContainText(
      "Nothing is enforced — the bye is yours to give on the first tee",
    );
    await expect(step(page, "Format")).not.toContainText("1 player left over");
  });

  test("the draft spreads the handicaps across the sides", async ({ page }) => {
    await openEvent(page);

    const review = step(page, "Review the teams");

    // Snake draft: the side that took the best player takes the worst of the
    // next round, so team 1 is the lowest index with the highest.
    const first = review.getByRole("article").first();
    await expect(first).toContainText("Ann Abbot");
    await expect(first).toContainText("1.2");
    await expect(first).toContainText("Hal Hobbs");
    await expect(first).toContainText("21.9");
    await expect(first).toContainText("HCP 23.1");
  });

  test("tapping two players swaps them", async ({ page }) => {
    const supabase = await openEvent(page);
    const review = step(page, "Review the teams");

    await review.getByRole("button", { name: /Ann Abbot/ }).click();
    await expect(review.getByRole("button", { name: /Ann Abbot/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await review.getByRole("button", { name: /Ben Barlow/ }).click();

    await expect(page.getByRole("status")).toContainText(
      "Ann Abbot and Ben Barlow changed places",
    );
    // One write, holding the whole arrangement — not two moves that pass
    // through a state where one side is short and the other over.
    const writes = supabase.callsTo("POST", "/rest/v1/rpc/admin_event_set_teams");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({
      in_teams: [
        [playerId(1), playerId(7)],
        [playerId(0), playerId(6)],
        [playerId(2), playerId(5)],
        [playerId(3), playerId(4)],
      ],
    });
  });

  test("the board is drawn for the format, with a legend that explains it", async ({
    page,
  }) => {
    await openEvent(page);

    const board = step(page, "What the leaderboard becomes");

    await expect(board.getByRole("columnheader", { name: "Team" })).toBeVisible();
    await expect(board.getByRole("columnheader", { name: "Score" })).toBeVisible();
    await expect(board).toContainText("The lowest card on each hole counts.");
    await expect(board).toContainText("A hole waits until everyone on the side has posted it");
  });

  test("a one-ball format says the card belongs to the side", async ({ page }) => {
    await openEvent(page, leagueEvent({ formatId: "scramble" }));

    await expect(step(page, "What the leaderboard becomes")).toContainText(
      "One score per side per hole, entered once",
    );
    await expect(step(page, "What the leaderboard becomes")).toContainText(
      "never reaches anyone’s index",
    );
  });

  /**
   * The honest half of the preview: where the engine cannot yet rank a
   * format, the page says so instead of showing stroke play under the other
   * format's name.
   */
  test("a scoring rule that isn't worked out yet admits it", async ({ page }) => {
    await openEvent(page, leagueEvent({ formatId: "match" }));

    const board = step(page, "What the leaderboard becomes");

    await expect(board.getByRole("columnheader", { name: "Status" })).toBeVisible();
    await expect(board).toContainText("match scoring isn’t worked out yet");
    await expect(board).toContainText("The sides, the cards and the format are all saved");
  });
});
