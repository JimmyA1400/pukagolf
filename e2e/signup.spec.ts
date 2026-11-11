import { expect, test, type Page } from "@playwright/test";

import { mockSupabase, type MockOptions } from "./supabase-mock";

const NEWCOMER = {
  id: "00000000-0000-4000-8000-00000000000f",
  phone: "+12395550199",
  fullName: "Test Golfer",
};

/** In the real database handle_new_user() writes this row on confirmation. */
function newcomerTables() {
  return {
    profiles: [
      {
        id: NEWCOMER.id,
        full_name: NEWCOMER.fullName,
        phone: NEWCOMER.phone,
        handicap_index: null,
        preferred_tee: null,
        preferred_tee_time: null,
        is_admin: false,
      },
    ],
    rounds: [],
    round_rsvps: [],
    tee_times: [],
  };
}

async function createAccount(page: Page, options: Partial<MockOptions> = {}) {
  const supabase = await mockSupabase(page, {
    user: NEWCOMER,
    tables: newcomerTables(),
    ...options,
  });

  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Test Golfer");
  await page.getByLabel("Mobile number").fill("2395550199");
  await page.getByLabel("Password").fill("correct-horse");
  await page.getByRole("button", { name: "Create account", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Confirm your number" })).toBeVisible();

  return supabase;
}

test.describe("joining the league", () => {
  test("a new player signs up by phone and confirms the texted code", async ({ page }) => {
    const supabase = await createAccount(page);

    expect(supabase.callsTo("POST", "/auth/v1/signup")[0]?.body).toMatchObject({
      phone: "+12395550199",
      password: "correct-horse",
      data: { full_name: "Test Golfer" },
    });

    await page.getByLabel("Code", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
    await expect(page.getByText("Signed in as Test Golfer.")).toBeVisible();

    expect(supabase.callsTo("POST", "/auth/v1/verify")[0]?.body).toMatchObject({
      phone: "+12395550199",
      token: "123456",
      type: "sms",
    });
  });

  test("an incomplete form is explained field by field, and nothing is sent", async ({ page }) => {
    const supabase = await mockSupabase(page, { user: NEWCOMER });

    await page.goto("/signup");
    await page.getByLabel("Name", { exact: true }).fill("Cher");
    await page.getByLabel("Mobile number").fill("555");
    await page.getByLabel("Password").fill("short");
    await page.getByRole("button", { name: "Create account", exact: true }).click();

    await expect(page.getByText("Enter your first and last name.")).toBeVisible();
    await expect(page.getByText("Enter a 10-digit US mobile number.")).toBeVisible();
    await expect(page.getByText("Use at least 8 characters.")).toBeVisible();
    expect(supabase.callsTo("POST", "/auth/v1/signup")).toHaveLength(0);
  });

  test("a wrong code gets a plain answer, never the provider's text", async ({ page }) => {
    await createAccount(page, {
      override: (call) =>
        call.path === "/auth/v1/verify"
          ? {
              status: 403,
              body: { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" },
            }
          : undefined,
    });

    await page.getByLabel("Code", { exact: true }).fill("000000");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "That code is wrong or has expired." }),
    ).toBeVisible();
    // Only the page itself: the raw error still goes to the console, and in
    // development Next's error overlay repeats it.
    await expect(page.locator("main").getByText("Token has expired")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Confirm your number" })).toBeVisible();
  });
});
