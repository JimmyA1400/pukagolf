/**
 * What the Golfer and Head Pro agents drive the site with.
 *
 *   import { openAs, shot, close } from "../../scripts/testers/session.mjs";
 *   const { page } = await openAs("golfer", { phone: true });
 *   await page.goto("/c/practice-ridge/league");
 *   await shot(page, "golfer", "league-page");
 *   await close();
 *
 * Signs in through the real form as one of the testers in
 * scripts/test-db/testers.local.json (made by make-testers.py), against the
 * local server, and refuses to go on unless the page says it is on the TEST
 * database. Screenshots land in .tester-runs/<who>/.
 */

import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, devices } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE_URL = process.env.TESTER_BASE_URL ?? "http://localhost:3000";
// The test project's id, so a run can prove it is on the test database and
// not on live. Not in the repo: set TESTER_TEST_REF (see .env.example).
const TEST_REF = process.env.TESTER_TEST_REF;
if (!TEST_REF) {
  throw new Error(
    "Set TESTER_TEST_REF to your test Supabase project id first. Without it " +
      "there is no way to tell the test database from live, so nothing runs.",
  );
}

let browser;

export function testers() {
  return JSON.parse(readFileSync(join(ROOT, "scripts", "test-db", "testers.local.json"), "utf8"));
}

/** A signed-in page. `phone: true` is an iPhone-sized screen, as on the course. */
export async function openAs(who, { phone = false } = {}) {
  const me = testers()[who];
  if (!me) throw new Error(`No tester called ${who}. Use "golfer" or "headPro".`);

  browser ??= await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    ...(phone ? devices["iPhone 13"] : { viewport: { width: 1280, height: 900 } }),
    baseURL: BASE_URL,
    timezoneId: "America/New_York",
    locale: "en-US",
  });
  const page = await context.newPage();

  await page.goto("/sign-in");
  await assertTestDatabase(page);
  // By email: the test project has phone sign-in switched off.
  await page.getByRole("button", { name: "Older account? Use your email" }).click();
  await page.getByLabel("Email").fill(me.email);
  await page.getByLabel("Password").fill(me.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 20_000 });

  return { page, context, me };
}

/** Stop unless the page's banner names the test project. */
export async function assertTestDatabase(page) {
  const banner = page.getByRole("complementary", { name: "Database" });
  const text = (await banner.textContent({ timeout: 15_000 }).catch(() => "")) ?? "";
  if (!text.includes(TEST_REF) || !text.toLowerCase().includes("test database")) {
    throw new Error(`STOP: this page is not on the test database. Banner says: "${text}"`);
  }
}

/** Full-page screenshot; returns the path, to open with the Read tool. */
export async function shot(page, who, name) {
  const dir = join(ROOT, ".tester-runs", who);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function close() {
  await browser?.close();
  browser = undefined;
}
