import { expect, test } from "@playwright/test";

import { CASEY, leagueTables, PUKAGOLF } from "./fixtures";
import { mockSupabase, type Row } from "./supabase-mock";

const IMPORTED = "00000000-0000-4000-8000-0000000000c9";

/** What /api/courses/[id] hands back, trimmed to what the form reads. */
const DETAIL: {
  external_id: string;
  name: string;
  hole_count: number;
  location_name: string;
  latitude: number;
  longitude: number;
  parMismatch: string | null;
} = {
  external_id: "ogapi-7781",
  name: "Arcadia Bluffs",
  hole_count: 18,
  location_name: "Arcadia, MI",
  latitude: 44.49,
  longitude: -86.23,
  parMismatch: null,
};

/**
 * A league event is played somewhere, and until now the only somewheres on
 * offer were the courses the league had already played. The outing creator
 * has always been able to search for a real course and pull its card in; this
 * is the same search and the same import, on the event form.
 */
test.describe("finding the course a league event is played on", () => {
  const openForm = async (page: import("@playwright/test").Page, detail = DETAIL) => {
    const tables = leagueTables();
    tables.profiles = tables.profiles.map((p) =>
      p.id === CASEY.id ? { ...p, is_admin: true } : p,
    );

    const supabase = await mockSupabase(page, {
      user: CASEY,
      tables,
      rpc: {
        league_events: () => [],
        // Importing writes the course, which is what puts it in the picker.
        import_course: () => {
          const courses = tables.courses as Row[];
          if (!courses.some((c) => c.id === IMPORTED)) {
            courses.push({
              id: IMPORTED,
              // import_course() puts it in the club, which is what the picker lists.
              club_id: PUKAGOLF,
              name: detail.name,
              hole_count: detail.hole_count,
              latitude: detail.latitude,
              longitude: detail.longitude,
              location_name: detail.location_name,
              attribution: "© OpenStreetMap contributors (ODbL 1.0) via OpenGolfAPI",
            });
          }

          return IMPORTED;
        },
      },
    });

    // After mockSupabase, whose blanket /api/** refusal would otherwise
    // answer these: Playwright checks the most recently added route first.
    await page.route("**/api/courses/search**", (route) =>
      route.fulfill({
        json: {
          courses: [
            { id: detail.external_id, name: detail.name, city: "Arcadia", state: "MI", par: 72 },
          ],
        },
      }),
    );
    await page.route(`**/api/courses/${detail.external_id}`, (route) =>
      route.fulfill({ json: detail }),
    );

    await page.goto("/sign-in");
    await page.getByLabel("Mobile number").fill("2395550132");
    await page.getByLabel("Password").fill("a-good-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");

    await page.goto("/league/events");
    await expect(page.getByRole("button", { name: "Create the event" })).toBeVisible();

    return supabase;
  };

  test("searching brings the course in, card and all, and picks it", async ({ page }) => {
    await openForm(page);

    const course = page.getByRole("combobox", { name: "Course" });
    // The league has only ever played Mock Links.
    await expect(page.getByRole("option", { name: "Arcadia Bluffs" })).toHaveCount(0);

    await page.getByRole("textbox", { name: "Search for a course" }).fill("arcadia");
    await page.getByRole("button", { name: "Search", exact: true }).click();

    await page.getByRole("button", { name: /Arcadia Bluffs/ }).click();

    // Imported, listed and already selected: no second step to forget.
    await expect(page.getByRole("status")).toContainText(
      "Arcadia Bluffs imported, with its pars and yardages",
    );
    await expect(page.getByRole("option", { name: "Arcadia Bluffs" })).toHaveCount(1);
    await expect(course).toHaveValue(IMPORTED);
  });

  test("a course whose own hole data disagrees with itself says so", async ({ page }) => {
    await openForm(page, {
      ...DETAIL,
      parMismatch: "Hole pars add up to 80, but this course is listed as par 69.",
    });

    await page.getByRole("textbox", { name: "Search for a course" }).fill("arcadia");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: /Arcadia Bluffs/ }).click();

    // Still imported and still picked — the warning is to act on, not a bar.
    // Filtered: Next's own route announcer is a role="alert" too.
    await expect(
      page.getByRole("alert").filter({ hasText: "Hole pars add up to 80" }),
    ).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Course" })).toHaveValue(IMPORTED);
  });

  test("the town fallback is not offered, because an event has nowhere to put one", async ({
    page,
  }) => {
    await openForm(page);

    await expect(
      page.getByRole("button", { name: /Set the location by town/ }),
    ).toHaveCount(0);
  });
});
