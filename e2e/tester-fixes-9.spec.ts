import { expect, test, type Page } from "@playwright/test";

import { CASEY, leagueTables, RILEY_ID, SATURDAY, THIS_WEEK } from "./fixtures";
import { enterHole, openLeague } from "./league";
import { type Call, type MockResponse, type Row } from "./supabase-mock";

/** The testers' ninth run, fixed. */

const card = (playerId: string, strokes: number[]): Row[] =>
  strokes.map((s, i) => ({ round_id: THIS_WEEK, player_id: playerId, hole: i + 1, strokes: s, entered_by: CASEY.id }));

const unsent = (page: Page) => page.getByRole("region", { name: "Scores not sent" });

/** Each element's text against its own box: what spills, and by how much. */
const spills = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const e = el as HTMLElement;
        const value = (e as HTMLInputElement).value ?? "";
        const style = getComputedStyle(e);
        const pen = document.createElement("canvas").getContext("2d")!;
        pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = value || e.textContent || "";
        const shown = style.textTransform === "uppercase" ? text.toUpperCase() : text;
        const spacing = parseFloat(style.letterSpacing) || 0;
        const needed = pen.measureText(shown).width + spacing * shown.length;
        const inside = e.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { text: shown.trim(), inside, needed };
      }),
  );

for (const sunlight of [false, true]) {
  test.describe(`the full card at 375px with the fallback fonts${sunlight ? ", in Sunlight" : ""}`, () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test.beforeEach(async ({ page }) => {
      // A phone on a weak signal may never get the web fonts: the card has
      // to fit with the fallback ones too.
      await page.route(/\.(woff2?|ttf)(\?.*)?$/, (route) => route.abort());
      if (sunlight) await page.addInitScript(() => localStorage.setItem("pukagolf:sunlight", "1"));
    });

    test("a 10 and the total fit, and the label clears hole 1", async ({ page }) => {
      const tables = leagueTables();
      tables.scores = [...card(RILEY_ID, [6, 5, 2, 6, 4, 5, 3, 5, 10]), ...card(CASEY.id, [7, 4, 4])];
      await openLeague(page, { tables });
      await page.getByRole("button", { name: "Full card", exact: true }).click();

      const boxes = await spills(page, 'input[aria-label^="Hole "]');
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) expect(box.needed, `"${box.text}" fits its box`).toBeLessThanOrEqual(box.inside + 0.5);

      const heads = await spills(page, "th");
      for (const head of heads) expect(head.needed, `"${head.text}" fits its column`).toBeLessThanOrEqual(head.inside + 0.5);

      // "Score" clear of hole 1's box, on every card shown.
      const gaps = await page.locator("tr").filter({ hasText: /^Score/ }).evaluateAll((rows) =>
        rows
          .filter((r) => (r as HTMLElement).offsetParent !== null)
          .map((r) => {
            const [label, first] = Array.from(r.children) as HTMLElement[];
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            const inner = first.querySelector("input, span.inline-flex") as HTMLElement | null;
            return (inner ?? first).getBoundingClientRect().left - text.right;
          }),
      );
      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(3);

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test("the leaderboard's Score and Thru stay apart", async ({ page }) => {
      const tables = leagueTables();
      tables.scores = card(CASEY.id, [4, 4, 4]);
      await openLeague(page, { tables });
      const head = page.locator("div.sm\\:hidden > div").first();
      const gap = await head.evaluate((row) => {
        const spans = Array.from(row.children) as HTMLElement[];
        const box = (el: HTMLElement) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect();
        };
        return box(spans[3]).left - box(spans[2]).right;
      });
      expect(gap).toBeGreaterThanOrEqual(6);
    });
  });
}


const teamCard = () => ({ ...leagueTables(), league_rules: [{ league_id: SATURDAY, scoring_mode: "team" }] });

test.describe("Team Card Scoring, saved fast", () => {
  test("every save goes, the buttons stay clickable, and the week loads one at a time", async ({ page }) => {
    const supabase = await openLeague(page, { tables: teamCard() });
    // A real server takes a while to answer; count the week loads running at once.
    let loading = 0;
    let most = 0;
    await page.route(/\/rest\/v1\//, async (route) => {
      const week = route.request().method() === "GET" && /\/rest\/v1\/rounds\?/.test(route.request().url());
      if (week) most = Math.max(most, ++loading);
      await new Promise((r) => setTimeout(r, 600));
      await route.fallback();
      if (week) loading -= 1;
    });

    const pad = page.getByRole("region", { name: /^Scoring / });
    const whose = page.getByRole("group", { name: "Whose card" });
    const started = supabase.callsTo("POST", "/rest/v1/scores").length;
    // A third of a second apart, as fast as the tester's script went: too
    // fast for Playwright's own waits, so tapped from inside the page.
    await page.evaluate(async () => {
      for (let i = 0; i < 9; i++) {
        const save = Array.from(document.querySelectorAll<HTMLButtonElement>('section[aria-label^="Scoring "] button')).find(
          (b) => /^(Save|Update) /.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
        );
        save?.click();
        await new Promise((r) => setTimeout(r, 300));
      }
    });
    // And straight after, the card buttons answer at once.
    await whose.getByRole("button", { name: "Riley Mock" }).click({ timeout: 2_000 });
    await pad.getByRole("button", { name: /^(Save|Update) / }).click({ timeout: 2_000 });

    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/scores").length - started, { timeout: 30_000 }).toBe(10);
    await expect(unsent(page)).toHaveCount(0);
    expect(most).toBeLessThanOrEqual(1);
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

test.describe("one outage, one batch", () => {
  test("every save held while PukaGolf was down says when it was entered", async ({ page }) => {
    const pukagolf = server();
    const supabase = await openLeague(page, { tables: teamCard(), override: pukagolf.override });
    const whose = page.getByRole("group", { name: "Whose card" });

    pukagolf.set(false);
    await whose.getByRole("button", { name: "Riley Mock" }).click();
    await enterHole(page, 1, 5);
    // The next one straight after, as Greg's hole 3 followed Pat's.
    await whose.getByRole("button", { name: "You" }).click();
    await enterHole(page, 1, 4);
    await expect(unsent(page)).toContainText("2 hole scores not sent yet");

    const before = supabase.callsTo("POST", "/rest/v1/scores").length;
    pukagolf.set(true);
    await unsent(page).getByRole("button", { name: "Send now" }).click();
    await expect(unsent(page)).toHaveCount(0, { timeout: 15_000 });

    const sent = supabase
      .callsTo("POST", "/rest/v1/scores")
      .slice(before)
      .map((c) => c.body as Row);
    expect(sent.map((b) => b.player_id).sort()).toEqual([CASEY.id, RILEY_ID].sort());
    expect(sent.every((b) => typeof b.entered_on_phone_at === "string")).toBe(true);
  });
});
