/**
 * The README's screenshots, taken from the app's own demo mode.
 *
 *   npm run dev -- --port 3010      # with no .env.local, so demo mode engages
 *   node scripts/screenshots.mjs
 *
 * Demo mode serves seeded fixtures and never reaches a database, which is the
 * point: no real club's week, no member's name, ends up in the repository.
 * SHOT_BASE overrides the address.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "@playwright/test";

const BASE = process.env.SHOT_BASE ?? "http://localhost:3010";
const OUT = fileURLToPath(new URL("../docs/images/", import.meta.url));
mkdirSync(OUT, { recursive: true });

/** The Next dev-tools badge and any dev overlay: not part of the app. */
const HIDE_DEV_CHROME = `
  nextjs-portal,
  [data-nextjs-dev-tools-button],
  [data-nextjs-toast] { display: none !important; }
`;

const DESKTOP = { width: 1280, height: 860 };

const shots = [
  { file: "landing", path: "/", viewport: DESKTOP },
  { file: "league", path: "/league", viewport: DESKTOP },
  { file: "league-full", path: "/league", viewport: DESKTOP, full: true },
  {
    file: "score-entry",
    path: "/league",
    phone: true,
    async before(page) {
      for (const name of [/scorecards/i]) {
        const byRole = page.getByRole("button", { name }).first();
        if (await byRole.isVisible().catch(() => false)) { await byRole.click(); break; }
        const byText = page.getByText(name).first();
        if (await byText.isVisible().catch(() => false)) { await byText.click(); break; }
      }
      await page.waitForTimeout(900);
      // Put the card itself at the top of the frame, not the leaderboard.
      const anchor = page.getByText(/you are keeping/i).first();
      if (await anchor.isVisible().catch(() => false)) {
        await anchor.evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.evaluate(() => window.scrollBy(0, -70));
      }
    },
  },
];

const browser = await chromium.launch({ channel: "chrome", headless: true });

for (const s of shots) {
  const context = await browser.newContext({
    ...(s.phone ? devices["iPhone 13"] : { viewport: s.viewport }),
    baseURL: BASE,
    colorScheme: "light",
    timezoneId: "America/New_York",
    locale: "en-US",
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  try {
    await page.goto(s.path, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2000);
    await page.addStyleTag({ content: HIDE_DEV_CHROME });
    if (s.before) await s.before(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}${s.file}.png`, fullPage: !!s.full });
    const text = await page.locator("main").innerText().catch(() => "(no main)");
    console.log(
      `OK   ${s.file}.png  <- ${s.path}${s.phone ? " [phone]" : ""}\n` +
        `     ${text.split("\n").filter(Boolean).slice(0, 5).join(" | ").slice(0, 180)}`,
    );
  } catch (err) {
    console.log(`FAIL ${s.file}  ${s.path}  ${err.message.split("\n")[0]}`);
  }
  await context.close();
}

await browser.close();
