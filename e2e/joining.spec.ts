import { expect, test, type Page } from "@playwright/test";

import { CASEY, leagueTables, PUKAGOLF, RILEY_ID } from "./fixtures";
import { mockSupabase, type MockOptions } from "./supabase-mock";

/**
 * Joining a club and running one. A club's QR code opens /join/<club>; the
 * player asks; the club's admin approves. The database decides who may do
 * what (supabase/tests/club_isolation.sql proves that); these check the pages
 * ask it the right things and say what happened.
 */

const MOOSE = { id: "c1", slug: "moose-ridge", name: "Moose Ridge", status: "active", isDemo: true };

async function signIn(page: Page) {
  await page.getByLabel("Mobile number").fill("2395550132");
  await page.getByLabel("Password").fill("a-good-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test.describe("joining a club", () => {
  test("signed out, the join page offers an account or a sign-in that comes back", async ({
    page,
  }) => {
    await mockSupabase(page, {
      rpc: { club_public: (args) => (args.in_slug === "moose-ridge" ? MOOSE : null) },
    });

    await page.goto("/join/moose-ridge");

    await expect(page.getByRole("heading", { name: "Moose Ridge" })).toBeVisible();
    await expect(page.getByText("A demonstration club")).toBeVisible();
    await expect(page.getByRole("link", { name: "Make an account" })).toHaveAttribute(
      "href",
      "/signup?next=%2Fjoin%2Fmoose-ridge",
    );
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?next=%2Fjoin%2Fmoose-ridge",
    );
  });

  test("signing in from the join page lands back on it, and asking sends the request", async ({
    page,
  }) => {
    let standing: string | null = null;
    const supabase = await mockSupabase(page, {
      user: CASEY,
      tables: leagueTables(),
      rpc: {
        club_public: (args) => (args.in_slug === "moose-ridge" ? MOOSE : null),
        my_club_request: () => standing,
        club_request_join: () => {
          standing = "requested";
          return "requested";
        },
      },
    });

    await page.goto("/sign-in?next=%2Fjoin%2Fmoose-ridge");
    await signIn(page);
    await page.waitForURL((url) => url.pathname === "/join/moose-ridge");

    await page.getByRole("button", { name: "Ask to join Moose Ridge" }).click();

    await expect(page.getByRole("status")).toContainText("Your request is with Moose Ridge");
    expect(supabase.callsTo("POST", "/rest/v1/rpc/club_request_join")[0]?.body).toEqual({
      in_slug: "moose-ridge",
    });
  });

  test("a sign-in link to somewhere else goes home instead", async ({ page }) => {
    await mockSupabase(page, { user: CASEY, tables: leagueTables() });

    await page.goto("/sign-in?next=https%3A%2F%2Fevil.example%2F");
    await signIn(page);

    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).host).not.toContain("evil.example");
  });
});

test.describe("running a club", () => {
  const overview = {
    club: { id: PUKAGOLF, slug: "pukagolf", name: "PukaGolf", status: "active", isDemo: false },
    leagues: [
      {
        id: "b0000000-0000-4000-8000-000000000001",
        slug: "saturday",
        name: "Saturday League",
        status: "active",
        playing: [CASEY.id],
        asking: [],
      },
    ],
    members: [
      {
        id: "n1",
        name: "Nina Newcomer",
        phone: "+12395550199",
        handicapIndex: null,
        isGuest: false,
        role: "player",
        status: "requested",
        staffCanFixScores: false,
        requestedAt: "2026-11-03T12:00:00Z",
      },
      {
        id: CASEY.id,
        name: CASEY.fullName,
        phone: "+12395550132",
        handicapIndex: 10,
        isGuest: false,
        role: "admin",
        status: "active",
        staffCanFixScores: false,
        requestedAt: "2026-09-01T12:00:00Z",
      },
      {
        id: RILEY_ID,
        name: "Riley Mock",
        phone: "+12395550133",
        handicapIndex: 4,
        isGuest: false,
        role: "staff",
        status: "active",
        staffCanFixScores: false,
        requestedAt: "2026-09-01T12:00:00Z",
      },
    ],
  };

  async function openAdmin(page: Page, asAdmin: boolean, extra: Partial<MockOptions> = {}) {
    const tables = leagueTables();
    tables.profiles = tables.profiles.map((p) =>
      p.id === CASEY.id ? { ...p, is_admin: asAdmin } : p,
    );

    const supabase = await mockSupabase(page, {
      user: CASEY,
      tables,
      rpc: { club_admin_overview: () => overview, is_owner: () => false, ...extra.rpc },
      override: extra.override,
    });

    await page.goto("/sign-in");
    await signIn(page);
    await page.waitForURL((url) => url.pathname === "/");
    await page.goto("/c/pukagolf/admin");

    return supabase;
  }

  test("a club admin approves a request and switches on score fixing for staff", async ({
    page,
  }) => {
    const supabase = await openAdmin(page, true);

    await expect(page.getByRole("heading", { name: "PukaGolf", level: 1 })).toBeVisible();
    await expect(page.getByAltText("QR code for joining PukaGolf")).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => supabase.callsTo("POST", "/rest/v1/rpc/club_decide").length).toBe(1);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/club_decide")[0]?.body).toEqual({
      in_club_id: PUKAGOLF,
      in_profile_id: "n1",
      in_approve: true,
    });

    // The box shows what the database says, so it is the call that matters.
    await page.getByLabel("Can fix scores").click();
    await expect
      .poll(() => supabase.callsTo("POST", "/rest/v1/rpc/club_set_staff_scores").length)
      .toBe(1);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/club_set_staff_scores")[0]?.body).toEqual({
      in_club_id: PUKAGOLF,
      in_profile_id: RILEY_ID,
      in_allowed: true,
    });
  });

  test("adding someone already in the club changes nothing, and says so", async ({ page }) => {
    const already = "Riley Mock is already in the club, as staff. Nothing was changed.";
    const supabase = await openAdmin(page, true, {
      // What 0056 answers for an active member: refused, with a hint, so the
      // page can tell it from a real refusal.
      override: (call) =>
        call.path === "/rest/v1/rpc/club_add_member"
          ? { status: 409, body: { code: "23505", message: already, hint: "already_member", details: null } }
          : undefined,
    });

    await page.getByLabel("Add by phone number").fill("2395550133");
    await page
      .getByLabel("Add by phone number")
      .locator("xpath=ancestor::form[1]")
      .getByRole("button", { name: "Add", exact: true })
      .click();

    await expect(page.getByRole("status").filter({ hasText: already })).toBeVisible();
    await expect(page.getByText("Added to the club.")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: already })).toHaveCount(0);
    expect(supabase.callsTo("POST", "/rest/v1/rpc/club_add_member")).toHaveLength(1);
  });

  test("a player who opens the admin page is told it isn't theirs", async ({ page }) => {
    const supabase = await openAdmin(page, false);

    await expect(page.getByText("This page is for PukaGolf's admins.")).toBeVisible();
    expect(supabase.callsTo("POST", "/rest/v1/rpc/club_admin_overview")).toHaveLength(0);
  });
});
